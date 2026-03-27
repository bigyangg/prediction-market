'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// Supervisor — High-level system oversight (20-minute periodic reviews)
// ═══════════════════════════════════════════════════════════════════════════
// NOT a per-trade classifier. Reviews system health and adjusts parameters.
// Uses Gemini for infrequent strategic decisions (max 20 calls/day).
// ═══════════════════════════════════════════════════════════════════════════

const logger = require('./logger');
const stateStore = require('./stateStore');
const geminiJudge = require('./geminiJudge');

class Supervisor {
  constructor() {
    this.checkInterval = 20 * 60 * 1000;  // 20 minutes
    this.lastCheck = 0;
    this.systemStatus = 'CONTINUE';
    this.riskLevel = 'KEEP';
    this.confidence = 75;
    this.callsToday = 0;
    this.maxCallsPerDay = 20;
    this.checkCount = 0;
  }

  // Compress system state into minimal summary
  buildSummary() {
    const trades = stateStore.trades || [];
    const recent = trades.slice(-20);
    const wins = recent.filter(t => t.status === 'win').length;
    const losses = recent.filter(t => t.status === 'loss').length;
    const open = recent.filter(t => t.status === 'open').length;

    // Detect losing streak
    let streak = 0;
    for (const t of [...recent].reverse()) {
      if (t.status === 'loss') streak++;
      else break;
    }

    const dailyPnl = stateStore.dailyPnl || 0;
    const balance = stateStore.usdcBalance || 0;

    return {
      recentTrades: `${wins}W / ${losses}L of last ${recent.length}`,
      openPositions: open,
      losingStreak: streak,
      dailyPnl: dailyPnl.toFixed(2),
      balance: balance.toFixed(2),
      winRate: recent.length > 0
        ? ((wins / (wins + losses)) * 100).toFixed(0) + '%'
        : 'N/A'
    };
  }

  // Should we call the supervisor right now?
  shouldCheck(forcedReason = null) {
    if (this.callsToday >= this.maxCallsPerDay) return false;

    const summary = this.buildSummary();

    // Always check if:
    if (forcedReason) return true;
    if (summary.losingStreak >= 3) return true;  // losing streak
    if (parseFloat(summary.dailyPnl) < -10) return true;  // big loss day

    // Regular 20-min check
    if (Date.now() - this.lastCheck > this.checkInterval) return true;

    return false;
  }

  async check(reason = 'scheduled') {
    if (!geminiJudge.isAvailable()) return this.systemStatus;

    this.callsToday++;
    this.checkCount++;
    this.lastCheck = Date.now();

    const summary = this.buildSummary();

    const prompt = `You are a trading system supervisor. 
Review this BTC prediction market trading system and give a high-level decision.

SYSTEM SUMMARY:
Recent trades: ${summary.recentTrades}
Win rate: ${summary.winRate}
Open positions: ${summary.openPositions}
Losing streak: ${summary.losingStreak}
Daily P&L: $${summary.dailyPnl}
Account balance: $${summary.balance}
Check reason: ${reason}

RULES YOU MUST FOLLOW:
- You are NOT executing trades
- You are NOT a real-time classifier  
- You only give high-level system decisions
- Be concise — respond with JSON only

Respond ONLY with this JSON:
{"decision":"CONTINUE"|"PAUSE","risk":"INCREASE"|"DECREASE"|"KEEP","confidence":0-100,"reason":"max 8 words"}`;

    try {
      const response = await geminiJudge.genAI.models.generateContent({
        model: geminiJudge.modelName,
        contents: prompt,
        config: { temperature: 0.1, maxOutputTokens: 100 }
      });

      const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      const result = JSON.parse(text.slice(s, e + 1));

      this.systemStatus = result.decision;
      this.riskLevel = result.risk;
      this.confidence = result.confidence;

      logger.info('Supervisor check', {
        checkReason: reason,
        decision: result.decision,
        risk: result.risk,
        confidence: result.confidence,
        llmReason: result.reason,
        callsToday: this.callsToday,
        summary
      });

      // Alert if pausing
      if (result.decision === 'PAUSE') {
        logger.warn('SUPERVISOR: system paused', { reason: result.reason });
        stateStore.addNews({
          type: 'error',
          agent: 'Supervisor',
          text: `⚠️ System paused by supervisor: ${result.reason}`
        });
      }

      return result.decision;

    } catch (e) {
      logger.debug('Supervisor check failed', { error: e.message });
      return 'CONTINUE';  // safe default
    }
  }

  // Start background supervisor loop
  start() {
    logger.info('Supervisor: started', {
      checkInterval: '20min',
      maxCallsPerDay: this.maxCallsPerDay
    });

    // Reset daily calls at midnight
    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() < 1) {
        this.callsToday = 0;
        logger.info('Supervisor: daily call counter reset');
      }
    }, 60000);

    // Main check loop
    setInterval(async () => {
      if (this.shouldCheck()) {
        const summary = this.buildSummary();
        const reason = summary.losingStreak >= 3
          ? `losing streak ${summary.losingStreak}`
          : 'scheduled';
        await this.check(reason);
      }
    }, 60000);  // check every minute IF conditions met
  }

  isSystemActive() {
    return this.systemStatus !== 'PAUSE';
  }

  getRiskMultiplier() {
    if (this.riskLevel === 'INCREASE') return 1.25;
    if (this.riskLevel === 'DECREASE') return 0.5;
    return 1.0;
  }

  getStats() {
    return {
      status: this.systemStatus,
      risk: this.riskLevel,
      confidence: this.confidence,
      callsToday: this.callsToday,
      lastCheck: this.lastCheck,
      checkCount: this.checkCount
    };
  }
}

module.exports = new Supervisor();
