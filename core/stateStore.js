'use strict';
const { EventEmitter } = require('events');
const logger = require('./logger');

class StateStore extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);

    // Engine state
    this.engineRunning = true;
    this.engineHalted = false;     // halted by daily loss limit
    this.readOnly = false;

    // P&L tracking
    this.totalPnl = 0;
    this.dailyPnl = 0;
    this.pnlHistory = [];          // [{ts, value}] for chart

    // Trade tracking
    this.trades = [];              // full trade log (in-memory)
    this.openTrades = new Map();   // tradeId → trade object
    this.winCount = 0;
    this.lossCount = 0;

    // Agent registry
    this.agents = {};              // name → {name, category, status, scans, lastScan}

    // Dashboard stats
    this.scansCompleted = 0;

    // Wallet
    this.walletAddress = null;
    this.usdcBalance = 0;

    // News feed
    this.newsFeed = [];            // [{agent, text, type, ts}] — last 50 items

    // ── Real on-chain data (Data API) ──────────────────────────────────────
    this.realPnl = {
      totalCashPnl:      0,
      totalCurrentValue: 0,
      openPositionCount: 0,
      winningPositions:  0
    };
    this.realPositions = [];       // live positions from data-api.polymarket.com
    this.realTrades    = [];       // on-chain trade history
  }

  // ── State mutators ─────────────────────────────────────────────────────────

  setEngineRunning(val) {
    this.engineRunning = val;
    this.emit('state', this.snapshot());
  }

  haltEngine(reason) {
    this.engineHalted = true;
    this.engineRunning = false;
    this.emit('state', this.snapshot());
  }

  resumeEngine() {
    this.engineHalted = false;
    this.engineRunning = true;
    this.emit('state', this.snapshot());
  }

  recordTrade(trade) {
    this.trades.unshift(trade);
    if (this.trades.length > 500) this.trades = this.trades.slice(0, 500);
    if (trade.status === 'open') {
      this.openTrades.set(trade.id, trade);
    }
    this.emit('trade', trade);
  }

  updateTrade(tradeId, patch) {
    const trade = this.openTrades.get(tradeId);
    if (trade) {
      Object.assign(trade, patch);
      if (patch.status && patch.status !== 'open') {
        this.openTrades.delete(tradeId);
      }
    }
    // Update in trades array too
    const idx = this.trades.findIndex(t => t.id === tradeId);
    if (idx >= 0) Object.assign(this.trades[idx], patch);
    this.emit('trade_update', { tradeId, patch });
  }

  updatePnl(delta) {
    this.dailyPnl += delta;
    this.totalPnl += delta;
    const entry = { ts: Date.now(), value: this.totalPnl };
    this.pnlHistory.push(entry);
    if (this.pnlHistory.length > 1440) this.pnlHistory = this.pnlHistory.slice(-1440);
    this.emit('pnl', { value: this.totalPnl, daily: this.dailyPnl, history: this.pnlHistory });
  }

  resetDailyPnl() {
    this.dailyPnl = 0;
    this.emit('state', this.snapshot());
  }

  recordWin() { this.winCount++; }
  recordLoss() { this.lossCount++; }

  updateAgent(name, data) {
    this.agents[name] = { ...(this.agents[name] || {}), ...data };
    this.emit('agent', { name, data: this.agents[name] });
  }

  incrementScans() {
    this.scansCompleted++;
  }

  // Atomically increment one of the scout counters on an agent
  // field: 'scoutedCount' | 'approvedCount' | 'filteredCount'
  incrementAgentCounter(name, field) {
    const agent = this.agents[name];
    if (!agent) return;
    agent[field] = (agent[field] || 0) + 1;
    this.emit('agent', { name, data: agent });
  }

  // ── Real on-chain data setters ────────────────────────────────────────────

  setRealPnl(data) {
    this.realPnl = { ...this.realPnl, ...data };
    this.emit('pnl_real', this.realPnl);
  }

  setRealPositions(positions) {
    this.realPositions = positions || [];
    this.emit('positions', this.realPositions);
  }

  setRealTrades(trades) {
    this.realTrades = trades || [];
    this.emit('trades_real', this.realTrades);
  }

  // Push a real cashPnl snapshot into the chart history
  pushPnl(cashPnl) {
    const entry = { ts: Date.now(), value: parseFloat(cashPnl) || 0 };
    this.pnlHistory.push(entry);
    if (this.pnlHistory.length > 1440) this.pnlHistory = this.pnlHistory.slice(-1440);
    this.emit('pnl', { value: entry.value, daily: this.dailyPnl, history: this.pnlHistory });
  }

  setWallet(address, balance) {
    this.walletAddress = address;
    // If balance looks like raw micro-USDC (>10000 and no decimal context), divide by 1e6
    if (balance > 10000) balance = balance / 1e6;
    this.usdcBalance = parseFloat(balance) || 0;
    this.emit('state', this.snapshot());
  }

  addNews(item) {
    this.newsFeed.unshift({ ...item, ts: Date.now() });
    if (this.newsFeed.length > 50) this.newsFeed = this.newsFeed.slice(0, 50);
    this.emit('news', item);
  }

  get openTradeCount() {
    return this.openTrades.size;
  }

  get winRate() {
    const total = this.winCount + this.lossCount;
    return total === 0 ? 0 : Math.round((this.winCount / total) * 100);
  }

  // ── Restore from Supabase on boot ─────────────────────────────────────────

  async loadFromSupabase() {
    const persistence = require('./persistence');
    try {
      const trades = await persistence.loadRecentTrades(100);
      if (trades.length > 0) {
        this.trades = trades.map(t => ({
          id:         t.id,
          agent:      t.agent,
          category:   t.category,
          question:   t.question,
          market:     t.question,      // stateStore/dashboard reads .market
          trade:      t.trade,
          side:       t.trade,         // dashboard reads .side
          stake:      t.stake,
          edge:       t.edge,
          confidence: t.confidence,
          marketProb: t.market_prob,
          trueProb:   t.true_prob,
          riskLevel:  t.risk_level,
          reason:     t.reason,
          status:     t.status,
          geminiValidated: t.gemini_validated,
          pnl:        t.pnl,
          openedAt:   t.opened_at,
          ts:         t.opened_at,
          orderId:    t.order_id
        }));
        logger.info('StateStore: loaded from Supabase', { trades: trades.length });
      }

      const stats = await persistence.getDailyStats(1);
      if (stats[0]) {
        // Restore today's counters directly on stateStore (riskManager reads these)
        this.dailyPnl  = parseFloat(stats[0].daily_pnl)      || 0;
        this.winCount  = parseInt(stats[0].winning_trades)    || 0;
        this.lossCount = parseInt(stats[0].losing_trades)     || 0;
        logger.info('RiskManager: restored daily stats from Supabase', {
          dailyPnl:    this.dailyPnl,
          totalTrades: parseInt(stats[0].total_trades) || 0
        });
      }
    } catch (e) {
      logger.warn('loadFromSupabase failed', { error: e.message });
    }
  }

  // ── Snapshot for dashboard ─────────────────────────────────────────────────

  snapshot() {
    return {
      engineRunning: this.engineRunning,
      engineHalted: this.engineHalted,
      readOnly: this.readOnly,
      totalPnl: this.totalPnl,
      dailyPnl: this.dailyPnl,
      pnlHistory: this.pnlHistory,
      trades: this.trades.slice(0, 100),
      openTradeCount: this.openTradeCount,
      winCount: this.winCount,
      lossCount: this.lossCount,
      winRate: this.winRate,
      scansCompleted: this.scansCompleted,
      agents: this.agents,
      walletAddress: this.walletAddress,
      usdcBalance:   this.usdcBalance,
      newsFeed:      this.newsFeed,
      realPnl:       this.realPnl,
      realPositions: this.realPositions,
      realTrades:    this.realTrades.slice(0, 50),
      geminiJudge:   require('./geminiJudge').getStats()
    };
  }
}

// Singleton
module.exports = new StateStore();
