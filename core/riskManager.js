'use strict';
require('dotenv').config();
const logger = require('./logger');
const stateStore = require('./stateStore');

class RiskManager {
  constructor() {
    this.maxStake       = parseFloat(process.env.MAX_STAKE_USD)        || 20;
    this.minStake       = parseFloat(process.env.MIN_STAKE_USD)        || 1;
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT_USD) || 50;
    this.maxOpenTrades  = parseInt(process.env.MAX_OPEN_TRADES)        || 8;
    this.minEdge        = parseFloat(process.env.MIN_EDGE_PCT)         || 5;
    this.minConfidence  = parseFloat(process.env.MIN_CONFIDENCE_PCT)   || 62;
    this._modeLogged    = false;
  }

  // ── Simulation mode — relaxed thresholds when no real wallet ─────────────
  get simulationMode() {
    const pk = process.env.POLYMARKET_PRIVATE_KEY || '';
    return !pk || pk === 'your_exported_private_key_here' || pk.startsWith('your_');
  }

  // ── Kelly Stake Sizing (SDD 4.1) ──────────────────────────────────────────
  calcStake(edge, confidence, riskLevel) {
    const absEdge        = Math.abs(edge);
    const kellyFraction  = (absEdge / 100) * (confidence / 100) * 0.25;
    const basePot        = this.maxStake * 10;
    let rawStake         = basePot * kellyFraction;

    const modifier = riskLevel === 'HIGH' ? 0.4 : riskLevel === 'MEDIUM' ? 0.7 : 1.0;
    rawStake *= modifier;

    return Math.max(this.minStake, Math.min(this.maxStake, parseFloat(rawStake.toFixed(2))));
  }

  // ── Approval Gate (SDD 4.2) — 7 conditions in strict order ───────────────
  approve(decision) {
    const { trade, edge, confidence, risk_level } = decision;
    const absEdge = Math.abs(edge || 0);

    // Relaxed thresholds in simulation mode
    const minEdge = this.simulationMode ? 2  : this.minEdge;
    const minConf = this.simulationMode ? 40 : this.minConfidence;

    // Log mode on first call
    if (!this._modeLogged) {
      this._modeLogged = true;
      logger.info('RiskManager mode', {
        mode:          this.simulationMode ? 'SIMULATION (relaxed)' : 'LIVE (strict)',
        minEdge,
        minConf,
        maxOpenTrades: this.maxOpenTrades,
        dailyLossLimit: this.dailyLossLimit
      });
    }

    // Condition 1: Engine halted
    if (stateStore.engineHalted) {
      return { approved: false, reason: 'Engine is halted (daily loss limit breached)' };
    }

    // Condition 2: Daily P&L breach
    if (stateStore.dailyPnl <= -this.dailyLossLimit) {
      logger.warn(`Daily loss limit breached: $${stateStore.dailyPnl.toFixed(2)}`);
      stateStore.haltEngine('daily_loss_limit');
      return { approved: false, reason: `Daily loss limit reached ($${this.dailyLossLimit})` };
    }

    // Condition 3: Open trade count
    const openCount = stateStore.openTradeCount;
    if (openCount >= this.maxOpenTrades) {
      return { approved: false, reason: `Max ${this.maxOpenTrades} open trades reached (${openCount} open)` };
    }

    // Condition 4: SKIP decision
    if (!trade || trade === 'SKIP') {
      return { approved: false, reason: 'Claude recommended SKIP' };
    }

    // Condition 5: Minimum edge
    if (absEdge < minEdge) {
      return { approved: false, reason: `Edge ${edge?.toFixed(1)}% < min ${minEdge}% (${this.simulationMode ? 'sim' : 'live'})` };
    }

    // Condition 6: Minimum confidence
    if (confidence < minConf) {
      return { approved: false, reason: `Confidence ${confidence}% < min ${minConf}% (${this.simulationMode ? 'sim' : 'live'})` };
    }

    // Condition 7: HIGH risk requires |edge| >= 10%
    if (risk_level === 'HIGH' && absEdge < 10) {
      return { approved: false, reason: `HIGH risk needs edge >= 10%, got ${edge?.toFixed(1)}%` };
    }

    // All conditions passed — calculate stake
    const stake = this.calcStake(edge, confidence, risk_level);
    return { approved: true, stake };
  }

  get engineHalted() {
    return stateStore.engineHalted;
  }

  // Stats for dashboard
  getStats() {
    return {
      dailyPnl:          stateStore.dailyPnl,
      totalPnl:          stateStore.totalPnl,
      openTrades:        stateStore.openTradeCount,
      dailyLossLimit:    this.dailyLossLimit,
      dailyLossUsedPct:  Math.min(100, Math.round((Math.abs(stateStore.dailyPnl) / this.dailyLossLimit) * 100)),
      simulationMode:    this.simulationMode,
      totalTrades:       stateStore.trades.length,
      wins:              stateStore.winCount,
      losses:            stateStore.lossCount
    };
  }
}

module.exports = new RiskManager();
