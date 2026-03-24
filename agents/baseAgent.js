'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// COST MODEL (Three-Model Architecture):
//
// Layer 1 — Haiku scout:    ~$0.001/market × N markets per scan
// Layer 2 — Gemini judge:   ~$0.0005/market × scout-approved markets (NEW)
// Layer 3 — Sonnet arbiter: ~$0.015/market × only high-conviction + big markets
//
// Estimated per scan: $0.01 scout + $0.05 Gemini + rare Sonnet ≈ $0.001 avg
// vs old two-model:   $0.01 scout + $0.03–0.05 Sonnet (94% reduction on judge)
//
// With $10 Anthropic credit: Sonnet only fires on edge≥6%, conf≥60%, liq≥$500k
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const Anthropic   = require('@anthropic-ai/sdk');
const logger      = require('../core/logger');
const stateStore  = require('../core/stateStore');
const riskManager = require('../core/riskManager');
const newsFetcher = require('../core/newsFetcher');
const polymarket  = require('../core/polymarketClient');
const persistence       = require('../core/persistence');
const geminiValidator   = require('../core/geminiValidator');
const geminiJudge       = require('../core/geminiJudge');
const traderTracker     = require('../core/traderTracker');

// ── Model config — read from env with exact fallbacks ─────────────────────────
const SCOUT_MODEL = process.env.SCOUT_MODEL || 'claude-haiku-4-5-20251001';
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-sonnet-4-6';

// ── Model 2 (Sonnet) system prompt — aggressive, decisive analyst ─────────────
const JUDGE_SYSTEM_PROMPT = `You are an aggressive quantitative prediction market analyst.
Your job is to find and act on mispricings. You should be DECISIVE.

Be DECISIVE. A SKIP is not safe — it means zero profit.
Trade when edge >= 3% AND confidence >= 40%.
Lean toward trading on borderline cases.

CRITICAL RULES:
- Markets near 50% are the most interesting — high uncertainty = opportunity
- Low probability markets (5-25%) with high volume often have edge
- You MUST commit to a direction — SKIP only when you have genuinely no signal at all
- False SKIPs cost as much as bad trades — do not default to SKIP

CONFIDENCE SCORING (most markets should score 50-70, do NOT default to 30-40):
- 70-85: strong signal, clear data, good liquidity
- 55-69: reasonable signal, some uncertainty
- 40-54: weak signal but a directional lean exists — still trade if edge >= 3%
- Below 40: SKIP — genuinely no signal

OUTPUT ONLY this exact JSON (no markdown, no explanation):
{"trade":"YES"|"NO"|"SKIP","true_probability":N,"confidence":N,"edge":N,"risk_level":"LOW"|"MEDIUM"|"HIGH","time_sensitivity":"LOW"|"MEDIUM"|"HIGH","reason":"under 10 words","key_factor":"main signal","warning":"main risk"}

WHEN TO TRADE:
- YES: you believe true prob > market prob by 3%+
- NO: you believe true prob < market prob by 3%+
- SKIP: genuinely no signal whatsoever (use sparingly)

RISK LEVELS:
- LOW: clear signal, good liquidity, confident estimate
- MEDIUM: reasonable signal, some uncertainty
- HIGH: thin liquidity OR very speculative — avoid unless edge > 10%`;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Robust JSON extractor — handles markdown fences + surrounding text ────────
function extractJSON(text) {
  // Step 1: strip markdown fences
  let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Step 2: try direct parse
  try { return JSON.parse(clean); } catch (_) { /* continue */ }

  // Step 3: find first { ... } block
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { /* continue */ }
  }

  // Step 4: find first [ ... ] block (array response)
  const aStart = clean.indexOf('[');
  const aEnd   = clean.lastIndexOf(']');
  if (aStart !== -1 && aEnd !== -1 && aEnd > aStart) {
    try { return JSON.parse(clean.slice(aStart, aEnd + 1)); } catch (_) { /* continue */ }
  }

  throw new Error('No valid JSON found in: ' + clean.slice(0, 100));
}

class BaseAgent {
  constructor({ name, category, intervalSeconds }) {
    this.name            = name;
    this.category        = category;
    this.intervalSeconds = intervalSeconds;
    this.running         = false;
    this._timer          = null;
    this._client         = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    if (!process.env.ANTHROPIC_API_KEY) {
      logger.error(`[${this.name}] ANTHROPIC_API_KEY not set — Claude calls will fail`, {
        hint: 'Set ANTHROPIC_API_KEY in .env'
      });
    }

    logger.info(`[${this.name}] Initialized`, {
      scoutModel: SCOUT_MODEL,
      judgeModel: JUDGE_MODEL,
      category,
      intervalSeconds
    });

    // Initialize agent state including scout counters
    stateStore.updateAgent(name, {
      name,
      category,
      status:        'idle',
      scans:         0,
      lastScan:      null,
      intervalSeconds,
      scoutedCount:  0,   // total markets Haiku evaluated this session
      approvedCount: 0,   // markets Haiku passed to Sonnet
      filteredCount: 0    // markets Haiku rejected
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(staggerMs = 0) {
    if (this.running) {
      logger.warn(`[${this.name}] start() called but already running — ignoring`);
      return;
    }
    this.running = true;
    const jitter = staggerMs >= 0 ? staggerMs : Math.floor(Math.random() * 10000);
    logger.info(`[${this.name}] Scheduled start in ${(jitter / 1000).toFixed(1)}s`, {
      category: this.category, intervalSeconds: this.intervalSeconds
    });

    await new Promise(r => setTimeout(r, jitter));
    if (!this.running) return;

    stateStore.updateAgent(this.name, { status: 'running' });
    logger.info(`[${this.name}] Active — scanning every ${this.intervalSeconds}s`);
    this._scheduleNext();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    stateStore.updateAgent(this.name, { status: 'stopped' });
    logger.info(`[${this.name}] Stopped`);
  }

  _scheduleNext() {
    if (!this.running) return;
    this._timer = setTimeout(async () => {
      await this._runScanSafe();
      this._scheduleNext();
    }, this.intervalSeconds * 1000);
  }

  // ── Scan wrapper — never crashes engine (NFR 6.2) ─────────────────────────

  async _runScanSafe() {
    const scanId = `${this.name}_${Date.now()}`;
    try {
      if (!stateStore.engineRunning) {
        stateStore.updateAgent(this.name, { status: 'paused' });
        logger.info(`[${this.name}] Scan ${scanId} skipped — engine stopped`);
        return;
      }
      if (stateStore.engineHalted) {
        stateStore.updateAgent(this.name, { status: 'halted' });
        logger.warn(`[${this.name}] Scan ${scanId} skipped — engine halted (daily loss limit)`);
        return;
      }

      stateStore.updateAgent(this.name, { status: 'scanning' });
      const t0 = Date.now();
      await this._runScan(scanId);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      stateStore.incrementScans();
      const scans = (stateStore.agents[this.name]?.scans || 0) + 1;
      stateStore.updateAgent(this.name, {
        status: 'running', scans, lastScan: new Date().toISOString()
      });
      logger.info(`[${this.name}] Scan ${scanId} completed in ${elapsed}s`);
    } catch (err) {
      logger.error(`[${this.name}] Scan ${scanId} CRASHED — caught at safe boundary`, {
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join(' | '),
        hint: 'Agent will continue on next interval'
      });
      stateStore.updateAgent(this.name, { status: 'error', lastError: err.message });
    }
  }

  // ── Core scan — two-model pipeline ───────────────────────────────────────

  async _runScan(scanId) {
    // Step 4: get all qualifying markets (Haiku scouts all of them)
    const markets = await this.getMarkets();
    if (!markets.length) {
      logger.info(`[${this.name}] [${scanId}] No qualifying markets (volume>100 & liquidity>200)`);
      return;
    }

    logger.info(`[${this.name}] [${scanId}] Scouting ${markets.length} markets with Haiku`, {
      scoutModel: SCOUT_MODEL
    });

    // ── Phase 1: Haiku scouts all markets (500ms between calls) ─────────────
    const approved = [];
    for (let i = 0; i < markets.length; i++) {
      if (!stateStore.engineRunning || stateStore.engineHalted) {
        logger.info(`[${this.name}] Scout loop aborted — engine stopped/halted`);
        break;
      }
      if (i > 0) await delay(500); // 500ms between Haiku calls

      const market = markets[i];
      const worthAnalyzing = await this.scoutMarket(market, scanId);

      // Save every scout decision to Supabase for intelligence analysis
      persistence.saveDecision({
        agent:         this.name,
        marketId:      market.id,
        question:      market.question,
        category:      market.category,
        scoutVerdict:  worthAnalyzing ? 'PASS' : 'SKIP',
        finalAction:   worthAnalyzing ? 'pending' : 'scout_skip'
      }).catch(() => {});

      if (worthAnalyzing) approved.push(market);
    }

    const total    = markets.length;
    const approved_ = approved.length;
    const filtered = total - approved_;
    logger.info(`[${this.name}] [${scanId}] Scout complete`, {
      total, approved: approved_, filtered,
      filterRate: `${Math.round((filtered / total) * 100)}%`
    });

    if (!approved.length) {
      logger.info(`[${this.name}] [${scanId}] All markets filtered by Haiku — no Sonnet calls needed`);
      return;
    }

    // ── Phase 2: Fetch news context once (cached 60s) ────────────────────────
    const newsCtx = await newsFetcher.getContextForCategory(this.category);

    // ── Phase 3: Gemini judges first; Sonnet only for high-conviction + big markets ─
    logger.info(`[${this.name}] [${scanId}] Sending ${approved_} approved markets to GeminiJudge`, {
      geminiModel: geminiJudge.modelName,
      judgeModel:  JUDGE_MODEL
    });

    for (const market of approved) {
      if (!stateStore.engineRunning || stateStore.engineHalted) {
        logger.info(`[${this.name}] Judge loop aborted — engine stopped/halted`);
        break;
      }
      await delay(1500);

      // Step 1: Try Gemini first (cheap — $0.30/$2.50 per 1M tokens)
      let decision    = await geminiJudge.analyze(market, newsCtx);
      let usedSonnet  = false;

      if (!decision) {
        // Gemini unavailable — fall back to full Sonnet path
        await this.analyzeMarket(market, newsCtx, scanId);
        continue;
      }

      decision.market_probability = market.marketProb ?? this._getMarketProbability(market);

      if (
        decision.trade !== 'SKIP' &&
        Math.abs(decision.edge || 0) >= 6 &&
        decision.confidence >= 60 &&
        (market.liquidity || 0) >= 500000  // only big markets worth Sonnet's cost
      ) {
        // High conviction Gemini signal — get Sonnet's second opinion
        logger.info('High conviction — requesting Sonnet arbiter', {
          geminiEdge: decision.edge,
          geminiConf: decision.confidence,
          market:     market.question?.slice(0, 50)
        });
        const sonnetDecision = await this._callSonnet(market, newsCtx, scanId);
        usedSonnet = true;

        if (sonnetDecision) {
          if (sonnetDecision.trade === decision.trade) {
            // Both agree — high confidence trade
            decision = sonnetDecision;
            decision.dualConfirmed = true;
            logger.info('DUAL CONFIRMED — Gemini + Sonnet agree', {
              trade: decision.trade,
              edge:  decision.edge
            });
          } else {
            // Disagreement — be conservative
            logger.info('Models DISAGREE — being conservative', {
              gemini: decision.trade,
              sonnet: sonnetDecision.trade
            });
            decision.trade  = 'SKIP';
            decision.reason = 'model disagreement — skipping';
          }
        }
      }

      // Track which model made the final decision
      decision._model        = usedSonnet ? 'sonnet' : 'gemini';
      decision._dualConfirmed = decision.dualConfirmed || false;

      await this._finalizeDecision(market, decision, scanId);
    }
  }

  // ── MODEL 1: Haiku Scout ──────────────────────────────────────────────────
  // Fast first-pass filter. No news context. Cheap.

  async scoutMarket(market, scanId) {
    const question   = market.question || market.title || 'Unknown market';
    const marketProb = this._getMarketProbability(market);
    const volume     = parseFloat(market.volume24hr || market.volume || 0).toFixed(0);
    const liquidity  = parseFloat(market.liquidity || 0).toFixed(0);
    const ctx = { scanId, agent: this.name, market: question.slice(0, 80), marketProb, volume, liquidity };

    const prompt = `Evaluate this prediction market for trading potential.

Market: "${question}"
Probability: ${marketProb}%
24h Volume: $${volume}
Liquidity: $${liquidity}

Respond with ONLY this JSON, nothing else, no markdown:
{"worth_analyzing":true,"reason":"brief reason"}`;

    // Increment scouted counter
    stateStore.incrementAgentCounter(this.name, 'scoutedCount');

    try {
      const t0  = Date.now();
      const msg = await this._client.messages.create({
        model:      SCOUT_MODEL,
        max_tokens: 120,
        messages:   [{ role: 'user', content: prompt }]
      });
      const elapsed = Date.now() - t0;
      const rawText = msg.content[0].text;
      logger.debug(`[${this.name}] Haiku raw response`, { agent: this.name, raw: rawText.slice(0, 200) });

      let result;
      try {
        result = extractJSON(rawText);
      } catch {
        logger.warn(`[${this.name}] Haiku JSON parse FAILED — failing open`, {
          ...ctx, raw: rawText.slice(0, 150), latencyMs: elapsed,
          hint: 'Defaulting to worth_analyzing: true so Sonnet can decide'
        });
        stateStore.incrementAgentCounter(this.name, 'approvedCount');
        return true;
      }

      const worth = result.worth_analyzing === true;
      const reason = result.reason || '';

      logger.info(`[${this.name}] [Scout] ${worth ? 'PASS' : 'SKIP'} — ${reason}`, {
        ...ctx, latencyMs: elapsed, model: SCOUT_MODEL
      });

      if (worth) {
        stateStore.incrementAgentCounter(this.name, 'approvedCount');
        stateStore.addNews({
          agent: this.name,
          text:  `[Scout PASS] ${question.slice(0, 65)} — ${reason}`,
          type:  'signal'
        });
      } else {
        stateStore.incrementAgentCounter(this.name, 'filteredCount');
        stateStore.addNews({
          agent: this.name,
          text:  `[Scout SKIP] ${question.slice(0, 65)} — ${reason}`,
          type:  'skip'
        });
      }

      return worth;
    } catch (err) {
      const code = this._logClaudeError(err, 'Haiku Scout', ctx);
      if (code === 'auth_error' || code === 'credits_exhausted') {
        logger.error(`[${this.name}] INVALID API KEY or NO CREDITS — stopping engine`);
        stateStore.setEngineRunning(false);
        return false;
      }
      if (code === 'rate_limited') {
        logger.warn(`[${this.name}] Rate limited — pausing agent for 30 seconds`);
        await delay(30000);
      }
      // Fail open — Haiku errors should not block Sonnet analysis
      logger.warn(`[${this.name}] Haiku error — failing open (worth_analyzing: true)`, {
        hint: 'Sonnet will make the final call'
      });
      stateStore.incrementAgentCounter(this.name, 'approvedCount');
      return true;
    }
  }

  // ── MODEL 2: Sonnet Arbiter ───────────────────────────────────────────────
  // Calls Sonnet and returns a parsed decision object, or null on error.
  // Called only when Gemini is unavailable OR for high-conviction confirmation.

  async _callSonnet(market, newsCtx, scanId) {
    const question   = market.question || market.title || 'Unknown market';
    const marketProb = this._getMarketProbability(market);
    const ctx = {
      scanId, agent: this.name, market: question.slice(0, 80),
      marketProb, volume: market.volume24hr, liquidity: market.liquidity,
      model: JUDGE_MODEL
    };

    // Sharp trader signals — what on-chain whales are doing in this market
    const sharpSignals = traderTracker.getSignalForMarket(
      market.question,
      market.conditionId || market.id
    );
    const sharpBlock = sharpSignals.length > 0
      ? `\nSHARP TRADER ACTIVITY (on-chain data — weight heavily):\n${sharpSignals.slice(0, 5).join('\n')}\nNote: if multiple sharp traders are on the same side, increase confidence. If against proposed direction, reconsider.\n`
      : '';

    const userPrompt = `MARKET: "${question}"
CATEGORY: ${this.category}
MARKET_PROBABILITY: ${marketProb}% (current YES price × 100)
VOLUME_24H: $${parseFloat(market.volume24hr || market.volume || 0).toFixed(0)}
LIQUIDITY: $${parseFloat(market.liquidity || 0).toFixed(0)}
MARKET_ID: ${market.id || market.conditionId || 'unknown'}
${sharpBlock}
CONTEXT DATA:
${JSON.stringify(newsCtx, null, 2).slice(0, 1200)}

Calibration: if market says 40% and you think 50%, edge=+10%. If market says 15% and you think 20%, edge=+5%. Be precise.
Analyze this market for mispricing. Output valid JSON only.`;

    let decision;
    try {
      const t0  = Date.now();
      const msg = await this._client.messages.create({
        model:          JUDGE_MODEL,
        max_tokens:     400,
        system:         JUDGE_SYSTEM_PROMPT,
        messages:       [{ role: 'user', content: userPrompt }]
      });
      const elapsed = Date.now() - t0;
      const rawText = msg.content.map(b => b.text || '').join('').trim();

      // Log the FULL raw response on every call — diagnose parse failures
      logger.warn('Claude raw response (first 500 chars)', {
        raw:   rawText.slice(0, 500),
        agent: this.name,
        model: JUDGE_MODEL
      });

      try {
        decision = extractJSON(rawText);
      } catch (e) {
        logger.warn('Sonnet JSON parse FAILED', {
          raw:   rawText?.slice(0, 300),
          error: e.message,
          agent: this.name
        });
        decision = {
          trade:              'SKIP',
          true_probability:   marketProb,
          confidence:         0,
          edge:               0,
          risk_level:         'HIGH',
          time_sensitivity:   'LOW',
          reason:             'response parse failed',
          key_factor:         'none',
          warning:            'response parsing failed',
          market_probability: marketProb,
          _parseError:        true
        };
      }

      logger.info(`[${this.name}] [Sonnet] Decision received`, {
        ...ctx, trade: decision.trade, edge: decision.edge,
        confidence: decision.confidence, risk: decision.risk_level,
        latencyMs: elapsed, parseError: decision._parseError || false
      });

      decision.market_probability = decision.market_probability || marketProb;

      // Edge recalculation: if Sonnet said YES/NO but edge is near zero,
      // recompute from the probabilities it returned
      if (decision.trade !== 'SKIP' && Math.abs(decision.edge || 0) < 1) {
        const recalcEdge = (decision.true_probability || 0) - (decision.market_probability || marketProb);
        if (Math.abs(recalcEdge) >= 2) {
          logger.info('Edge recalculated from probabilities', {
            original:     decision.edge,
            recalculated: parseFloat(recalcEdge.toFixed(1))
          });
          decision.edge = parseFloat(recalcEdge.toFixed(1));
        }
      }

      logger.info('═══ SONNET DECISION ═══ ' + JSON.stringify({
        TRADE:      decision.trade,
        EDGE:       decision.edge,
        CONFIDENCE: decision.confidence,
        RISK:       decision.risk_level,
        TRUE_PROB:  decision.true_probability,
        MKT_PROB:   decision.market_probability,
        REASON:     decision.reason
      }));

      return decision;

    } catch (e) {
      logger.error('[Sonnet Judge] API call FAILED', {
        message:      e.message,
        status:       e.status,
        errorType:    e.error?.type,
        errorMessage: e.error?.error?.message,
        headers:      e.headers
      });

      if (e.status === 401) {
        logger.error('AUTH ERROR — ANTHROPIC_API_KEY is invalid or revoked');
        logger.error('Go to console.anthropic.com → API Keys → verify key is active');
        stateStore.setEngineRunning(false);
        return null;
      } else if (e.status === 402) {
        logger.error('PAYMENT REQUIRED — add credits at console.anthropic.com');
        stateStore.setEngineRunning(false);
        return null;
      } else if (e.status === 429) {
        logger.error('RATE LIMITED — too many requests');
        await delay(30000);
      } else if (!e.status) {
        logger.error('NETWORK ERROR — cannot reach api.anthropic.com from Railway');
        logger.error('Check Railway region settings');
      }

      stateStore.addNews({ agent: this.name, text: `ERROR: Sonnet unavailable — ${question.slice(0, 50)}`, type: 'skip' });
      return {
        trade:              'SKIP',
        edge:               0,
        confidence:         0,
        reason:             `API error ${e.status || 'network'}`,
        true_probability:   50,
        market_probability: marketProb,
        risk_level:         'HIGH',
        time_sensitivity:   'LOW',
        key_factor:         'none',
        warning:            'API failed'
      };
    }
  }

  // ── Post-decision pipeline ─────────────────────────────────────────────────
  // Risk approval → Gemini validation → trade execution.
  // Called after either Gemini or Sonnet has produced a decision.

  async _finalizeDecision(market, decision, scanId) {
    const question = market.question || market.title || 'Unknown market';
    const marketProb = decision.market_probability || this._getMarketProbability(market);
    const ctx = { scanId, agent: this.name, market: question.slice(0, 80), marketProb };

    stateStore.addNews({
      agent: this.name,
      text:  `${decision.trade} | ${decision.edge >= 0 ? '+' : ''}${decision.edge}% edge | ${decision._model || '?'} | ${question.slice(0, 60)}`,
      type:  decision.trade === 'SKIP' ? 'skip' : 'signal'
    });

    // Save judge decision to Supabase before approval check
    persistence.saveDecision({
      agent:            this.name,
      marketId:         market.id,
      question:         market.question,
      category:         market.category,
      scoutVerdict:     'PASS',
      claudeTrade:      decision.trade,
      claudeEdge:       decision.edge,
      claudeConfidence: decision.confidence,
      claudeTrueProb:   decision.true_probability,
      claudeRisk:       decision.risk_level,
      claudeReason:     decision.reason,
      finalAction:      'pending'
    }).catch(() => {});

    // Risk approval gate — ONLY path to execution (REQ-RSK-001)
    const approval = riskManager.approve(decision);

    logger.info('═══ APPROVAL RESULT ═══ ' + JSON.stringify({
      approved: approval.approved,
      REASON:   approval.reason || 'approved',
      stake:    approval.stake
    }));

    if (!approval.approved) {
      logger.info('Trade REJECTED', {
        agent:       this.name,
        reason:      approval.reason,
        market:      market.question?.slice(0, 55),
        trade:       decision.trade,
        edge:        decision.edge,
        confidence:  decision.confidence,
        riskLevel:   decision.risk_level,
        trueProb:    decision.true_probability,
        marketProb:  decision.market_probability,
        openTrades:  stateStore.openTradeCount,
        dailyPnl:    stateStore.dailyPnl,
        halted:      stateStore.engineHalted
      });
      return;
    }

    // Gemini validation — live web search + independent check
    const validation = await geminiValidator.validate(market, {
      ...decision,
      market_probability: market.marketProb ?? this._getMarketProbability(market)
    });

    if (validation.verdict === 'VETO') {
      logger.warn(`[${this.name}] Trade VETOED by GeminiValidator`, {
        ...ctx, reason: validation.reason, concern: validation.key_concern,
        confidence: validation.confidence, searchUsed: validation.search_used
      });
      stateStore.addNews({
        agent: this.name,
        text:  `VETOED by Gemini: ${validation.reason} — ${question.slice(0, 50)}`,
        type:  'skip'
      });
      persistence.saveDecision({
        agent:            this.name,
        marketId:         market.id,
        question:         market.question,
        category:         market.category,
        scoutVerdict:     'PASS',
        claudeTrade:      decision.trade,
        claudeEdge:       decision.edge,
        claudeConfidence: decision.confidence,
        geminiVerdict:    'VETO',
        geminiConfidence: validation.confidence,
        geminiReason:     validation.reason,
        finalAction:      'gemini_veto',
        rejectionReason:  validation.key_concern
      }).catch(() => {});
      return;
    }

    if (!validation._skipped && !validation._error) {
      logger.info(`[${this.name}] Trade CONFIRMED by GeminiValidator`, {
        reason: validation.reason, searchUsed: validation.search_used
      });
    }

    await this.executeTrade(market, decision, approval.stake, scanId);
  }

  // ── Full Sonnet path (Gemini unavailable OR manual trades) ────────────────
  // Calls Sonnet and runs the full post-decision pipeline.

  async analyzeMarket(market, newsCtx, scanId) {
    const decision = await this._callSonnet(market, newsCtx, scanId);
    if (!decision) return;
    decision._model        = 'sonnet';
    decision._dualConfirmed = false;
    await this._finalizeDecision(market, decision, scanId);
  }

  // ── Trade Execution ───────────────────────────────────────────────────────

  async executeTrade(market, decision, stake, scanId) {
    const tradeId  = `${this.name}_${Date.now()}`;
    const question = market.question || market.title || 'Unknown';
    const side     = decision.trade;
    const tokenId  = this._getTokenId(market, side);
    const price    = Math.max(0.01, Math.min(0.99, decision.true_probability / 100));
    const ctx = {
      tradeId, scanId, agent: this.name, side, stake, price,
      edge: decision.edge, confidence: decision.confidence, risk: decision.risk_level
    };

    const trade = {
      id: tradeId, agent: this.name, category: this.category,
      market: question, marketId: market.id || market.conditionId,
      side, stake, price, edge: decision.edge, confidence: decision.confidence,
      riskLevel: decision.risk_level, reason: decision.reason,
      warning: decision.warning, keyFactor: decision.key_factor,
      status: 'open', orderId: null, simulated: false,
      decisionModel: decision._model || 'sonnet',
      dualConfirmed: decision._dualConfirmed || false,
      ts: new Date().toISOString()
    };

    logger.info(`[${this.name}] Executing trade`, { ...ctx, market: question.slice(0, 60) });

    try {
      const result = await polymarket.placeOrder({
        tokenId,
        side:            side === 'YES' ? 'BUY' : 'SELL',
        usdcAmount:      stake,
        marketQuestion:  question
      });

      trade.orderId   = result.orderId || result.order_id || tradeId;
      trade.simulated = result.simulated || false;
      stateStore.recordTrade(trade);
      persistence.saveTrade(trade).catch(() => {});

      logger.info(`[${this.name}] Trade OPEN`, {
        ...ctx, orderId: trade.orderId,
        simulated: trade.simulated, market: question.slice(0, 60)
      });
    } catch (err) {
      trade.status = 'failed';
      trade.error  = err.message;
      stateStore.recordTrade(trade);
      persistence.saveTrade(trade).catch(() => {});
      logger.error(`[${this.name}] Trade FAILED`, {
        ...ctx, error: err.message,
        hint: 'Order not placed — see PolymarketClient logs for details'
      });
    }
  }

  // ── Shared Claude error logger ─────────────────────────────────────────────

  _logClaudeError(err, label, ctx) {
    const hint =
      err.status === 401 ? 'Check ANTHROPIC_API_KEY in Railway Variables' :
      err.status === 429 ? 'Rate limited — reduce scan frequency' :
      err.status === 402 ? 'Credits exhausted — add funds at console.anthropic.com' :
      'Unknown error';

    if (err.status === 401) {
      logger.error(`[${this.name}] [${label}] AUTH FAILED`, {
        error:   err.message,
        status:  err.status,
        type:    err.error?.type,
        message: err.error?.message,
        hint
      });
      return 'auth_error';
    } else if (err.status === 402) {
      logger.error(`[${this.name}] [${label}] CREDITS EXHAUSTED`, {
        error:   err.message,
        status:  err.status,
        type:    err.error?.type,
        message: err.error?.message,
        hint
      });
      return 'credits_exhausted';
    } else if (err.status === 429) {
      logger.error(`[${this.name}] [${label}] RATE LIMITED`, {
        error:   err.message,
        status:  err.status,
        type:    err.error?.type,
        message: err.error?.message,
        hint
      });
      return 'rate_limited';
    } else if (err.status === 529 || err.status === 503) {
      logger.warn(`[${this.name}] [${label}] API OVERLOADED`, {
        status: err.status, hint: 'Temporary — will retry next scan cycle'
      });
      return 'overloaded';
    } else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      logger.warn(`[${this.name}] [${label}] TIMED OUT`, ctx);
      return 'timeout';
    } else {
      logger.error(`[${this.name}] [${label}] API call FAILED`, {
        error:   err.message,
        status:  err.status,
        type:    err.error?.type,
        message: err.error?.message,
        hint
      });
      return 'error';
    }
  }

  // ── Market helpers ────────────────────────────────────────────────────────

  _getMarketProbability(market) {
    // marketProb is pre-computed by mapMarket normalization
    if (market.marketProb !== undefined) return market.marketProb;
    if (market.outcomePrices) {
      try {
        const prices = Array.isArray(market.outcomePrices)
          ? market.outcomePrices
          : JSON.parse(market.outcomePrices);
        return Math.round(parseFloat(prices[0]) * 100);
      } catch { /* fall through */ }
    }
    if (market.bestAsk)   return Math.round(parseFloat(market.bestAsk) * 100);
    if (market.lastPrice) return Math.round(parseFloat(market.lastPrice) * 100);
    return 50;
  }

  _getTokenId(market, side) {
    // tokenIds is a pre-parsed array from mapMarket normalization
    // clobTokenIds is also set to the same array by mapMarket
    let ids = null;

    if (Array.isArray(market.tokenIds) && market.tokenIds.length > 0) {
      ids = market.tokenIds;
    } else if (market.clobTokenIds) {
      try {
        ids = Array.isArray(market.clobTokenIds)
          ? market.clobTokenIds
          : JSON.parse(market.clobTokenIds);
      } catch (e) {
        logger.error('_getTokenId: failed to parse clobTokenIds', {
          raw: market.clobTokenIds, error: e.message
        });
      }
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      logger.error('_getTokenId: no tokenIds found', {
        market: market.question?.slice(0, 50),
        tokenIds: market.tokenIds,
        clobTokenIds: market.clobTokenIds
      });
      return market.tokenId || market.conditionId || '';
    }

    const tokenId = side === 'YES' ? ids[0] : ids[1];
    if (!tokenId) {
      logger.error('_getTokenId: empty tokenId for side', { side, ids });
      return '';
    }

    logger.info('Token resolved', {
      side,
      tokenId,
      tokenIds: ids,
      market: market.question?.slice(0, 50)
    });
    return tokenId;
  }

  // ── Override in subclasses ─────────────────────────────────────────────────
  async getMarkets() {
    return polymarket.getActiveMarkets({ category: this.category });
  }
}

module.exports = BaseAgent;
