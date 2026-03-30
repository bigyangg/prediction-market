'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// TRADING RULES ENGINE
// ═══════════════════════════════════════════════════════════════════════════
// Centralized, deterministic trading rules. No ambiguity.
// All thresholds in one place. Machine-executable.
// ═══════════════════════════════════════════════════════════════════════════

const logger = require('./logger');

const RULES = {
  // ─── Entry Rules ─────────────────────────────────────────────────────────
  ENTRY: {
    minConfidence: 65,           // Minimum signal confidence to enter
    minLiquidity: 5000,          // Minimum market liquidity in USD
    maxSpread: 0.04,             // Maximum bid-ask spread (4%)
    minTimeToResolution: 120,    // Minimum seconds before market resolves
    maxOpenPositions: 1,         // Max concurrent BTC positions
    cooldownSeconds: 300,        // 5 minutes between trades
    minEdge: 5,                  // Minimum edge percentage
  },

  // ─── Exit Rules ──────────────────────────────────────────────────────────
  EXIT: {
    takeProfitPct: 25,           // Exit at +25% gain
    stopLossPct: 15,             // Exit at -15% loss
    forceExitSeconds: 30,        // Force exit 30s before resolution
    checkIntervalMs: 15000,      // Check positions every 15 seconds
  },

  // ─── Risk Rules ──────────────────────────────────────────────────────────
  RISK: {
    maxDailyLossPct: 5,          // Max 5% daily loss (of starting capital)
    basePositionPct: 2,          // Base position size: 2% of capital
    maxPositionPct: 5,           // Max position size: 5% of capital
    maxLosingStreak: 3,          // Pause after 3 consecutive losses
    capitalBase: 300,            // Starting capital for calculations
  },

  // ─── Market Selection ────────────────────────────────────────────────────
  MARKET: {
    // Exact patterns for 5-minute BTC markets
    patterns: [
      /btc.*(?:5|five).?min/i,
      /bitcoin.*(?:5|five).?min/i,
      /(?:5|five).?min.*btc/i,
      /(?:5|five).?min.*bitcoin/i,
      /btc.*up.?(?:or|\/|,).?down/i,
      /bitcoin.*up.?(?:or|\/|,).?down/i,
    ],
    // Patterns to REJECT (longer-term markets)
    rejectPatterns: [
      /year/i,
      /month/i,
      /week/i,
      /2025/i,
      /2026/i,
      /2027/i,
      /election/i,
      /president/i,
    ],
    cacheSeconds: 300,           // Cache valid market for 5 minutes
    minTokens: 2,                // Must have YES and NO tokens
  },

  // ─── Regime Detection ────────────────────────────────────────────────────
  REGIME: {
    maxVolatilityPctPerMin: 0.3, // Skip if volatility > 0.3%/min
    minRange24hPct: 1,           // Skip if 24h range < 1% (ranging)
    orderBookNeutralMin: 0.45,   // Order book neutral zone
    orderBookNeutralMax: 0.55,
  },

  // ─── Signal Thresholds ───────────────────────────────────────────────────
  SIGNAL: {
    strongMomentumPct: 0.05,     // Strong momentum threshold
    weakMomentumPct: 0.02,       // Weak momentum threshold
    minConsecutiveMoves: 2,      // Min consecutive moves for consistency
    volatilitySpikeMultiple: 4,  // Skip if move > 4x average
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// RULE EVALUATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if entry conditions are met
 * @returns {{ canEnter: boolean, reason: string, checks: object }}
 */
function evaluateEntry(signal, market, state) {
  const checks = {
    hasSignal: signal && signal.signal !== 'SKIP',
    confidence: signal?.confidence >= RULES.ENTRY.minConfidence,
    liquidity: market?.liquidity >= RULES.ENTRY.minLiquidity,
    spread: market?.spread <= RULES.ENTRY.maxSpread,
    timeToResolution: market?.secondsToResolution >= RULES.ENTRY.minTimeToResolution,
    noOpenPositions: state.openPositions < RULES.ENTRY.maxOpenPositions,
    cooldownExpired: state.secondsSinceLastTrade >= RULES.ENTRY.cooldownSeconds,
    dailyLossOk: state.dailyLossPct < RULES.RISK.maxDailyLossPct,
    noLosingStreak: state.losingStreak < RULES.RISK.maxLosingStreak,
    hasEdge: (signal?.edge || 0) >= RULES.ENTRY.minEdge,
  };

  const failedChecks = Object.entries(checks)
    .filter(([_, passed]) => !passed)
    .map(([name]) => name);

  const canEnter = failedChecks.length === 0;
  const reason = canEnter ? 'all checks passed' : `failed: ${failedChecks.join(', ')}`;

  logger.debug('[TradingRules] Entry evaluation', {
    canEnter,
    reason,
    signalConf: signal?.confidence,
    marketLiq: market?.liquidity,
  });

  return { canEnter, reason, checks, failedChecks };
}

/**
 * Check if exit conditions are met
 * @returns {{ shouldExit: boolean, reason: string, pnlPct: number }}
 */
function evaluateExit(position) {
  if (!position) return { shouldExit: false, reason: 'no position' };

  const { entryPrice, currentPrice, secondsToResolution } = position;
  
  if (!entryPrice || !currentPrice) {
    return { shouldExit: false, reason: 'missing price data' };
  }

  const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

  // Take profit
  if (pnlPct >= RULES.EXIT.takeProfitPct) {
    logger.info('[TradingRules] Take profit triggered', { pnlPct: pnlPct.toFixed(2) });
    return { shouldExit: true, reason: 'TAKE_PROFIT', pnlPct };
  }

  // Stop loss
  if (pnlPct <= -RULES.EXIT.stopLossPct) {
    logger.warn('[TradingRules] Stop loss triggered', { pnlPct: pnlPct.toFixed(2) });
    return { shouldExit: true, reason: 'STOP_LOSS', pnlPct };
  }

  // Time-based exit
  if (secondsToResolution !== undefined && secondsToResolution <= RULES.EXIT.forceExitSeconds) {
    logger.info('[TradingRules] Time exit triggered', { secondsToResolution });
    return { shouldExit: true, reason: 'TIME_EXIT', pnlPct };
  }

  return { shouldExit: false, reason: 'hold', pnlPct };
}

/**
 * Calculate position size based on rules
 * @returns {{ stake: number, reason: string }}
 */
function calculatePositionSize(signal, state) {
  const capital = state.capital || RULES.RISK.capitalBase;
  const baseSize = capital * (RULES.RISK.basePositionPct / 100);
  const maxSize = capital * (RULES.RISK.maxPositionPct / 100);

  // Confidence modifier: scale by confidence/75
  const confModifier = Math.min(1.5, (signal?.confidence || 65) / 75);

  // Losing streak reduction: -25% per loss
  const streakReduction = Math.pow(0.75, state.losingStreak || 0);

  let stake = baseSize * confModifier * streakReduction;
  stake = Math.max(1, Math.min(maxSize, stake));
  stake = parseFloat(stake.toFixed(2));

  const reason = `base=$${baseSize.toFixed(2)} × conf=${confModifier.toFixed(2)} × streak=${streakReduction.toFixed(2)}`;

  logger.debug('[TradingRules] Position size', { stake, reason });

  return { stake, reason };
}

/**
 * Check if market matches 5-minute BTC pattern
 * @returns {{ isValid: boolean, reason: string }}
 */
function validateMarketPattern(question) {
  if (!question) return { isValid: false, reason: 'no question' };

  // Check reject patterns first
  for (const pattern of RULES.MARKET.rejectPatterns) {
    if (pattern.test(question)) {
      return { isValid: false, reason: `rejected: matches ${pattern}` };
    }
  }

  // Check valid patterns
  for (const pattern of RULES.MARKET.patterns) {
    if (pattern.test(question)) {
      return { isValid: true, reason: `matched: ${pattern}` };
    }
  }

  return { isValid: false, reason: 'no 5-min pattern match' };
}

/**
 * Check regime conditions (should we trade at all?)
 * @returns {{ canTrade: boolean, reason: string }}
 */
function evaluateRegime(marketData) {
  if (!marketData) return { canTrade: true, reason: 'no data, allowing trade' };

  const { volatilityPctPerMin, range24hPct, orderBookRatio } = marketData;

  // High volatility
  if (volatilityPctPerMin > RULES.REGIME.maxVolatilityPctPerMin) {
    return { canTrade: false, reason: `volatility too high: ${volatilityPctPerMin.toFixed(3)}%/min` };
  }

  // Low range (ranging market)
  if (range24hPct < RULES.REGIME.minRange24hPct) {
    return { canTrade: false, reason: `ranging market: 24h range ${range24hPct.toFixed(2)}%` };
  }

  // Neutral order book
  if (orderBookRatio >= RULES.REGIME.orderBookNeutralMin && 
      orderBookRatio <= RULES.REGIME.orderBookNeutralMax) {
    return { canTrade: false, reason: `neutral order book: ${orderBookRatio.toFixed(3)}` };
  }

  return { canTrade: true, reason: 'regime ok' };
}

/**
 * Get all rules for dashboard display
 */
function getRulesConfig() {
  return JSON.parse(JSON.stringify(RULES));
}

module.exports = {
  RULES,
  evaluateEntry,
  evaluateExit,
  calculatePositionSize,
  validateMarketPattern,
  evaluateRegime,
  getRulesConfig,
};
