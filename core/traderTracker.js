'use strict';
const axios      = require('axios');
const logger     = require('./logger');
const stateStore = require('./stateStore');

const DATA_API = 'https://data-api.polymarket.com';

// Known sharp traders — top performers on Polymarket leaderboard
// These are PUBLIC addresses visible on polymarket.com/leaderboard
// Add more via POST /api/traders/add or they are auto-discovered from leaderboard
const SHARP_WALLETS = [
  // { address, alias, description }
  // Start empty — auto-discovery fills this from the leaderboard API
];

class TraderTracker {
  constructor() {
    this.wallets       = [...SHARP_WALLETS];
    this.recentTrades  = new Map();  // address → trades[]
    this.positions     = new Map();  // address → positions[]
    this.enabled       = true;
    this.lastFetch     = 0;
    this.fetchInterval = 5 * 60 * 1000;  // 5 minutes
    this.leaderboard   = [];
  }

  async init() {
    logger.info('TraderTracker: initializing');
    await this.fetchLeaderboard();
    if (this.wallets.length > 0) {
      await this.fetchAllPositions();
    }
    logger.info('TraderTracker: active', {
      wallets:     this.wallets.length,
      leaderboard: this.leaderboard.length
    });
  }

  // ── Leaderboard discovery ──────────────────────────────────────────────────

  async fetchLeaderboard() {
    try {
      const res = await axios.get(`${DATA_API}/leaderboard`, {
        params:  { limit: 20, window: '1w' },
        timeout: 10000
      });

      const traders = Array.isArray(res.data) ? res.data : [];
      this.leaderboard = traders.map(t => ({
        address: t.proxyWallet || t.address,
        alias:   t.name || t.pseudonym || 'Trader',
        pnl:     t.pnlUsd     || 0,
        volume:  t.volume     || 0,
        trades:  t.tradesCount || 0,
        winRate: t.percentPnl  || 0
      })).filter(t => t.address);

      // Auto-add top 5 to watch list if not already present
      for (const trader of this.leaderboard.slice(0, 5)) {
        if (!this.wallets.find(w => w.address === trader.address)) {
          this.wallets.push({
            address:     trader.address,
            alias:       trader.alias,
            description: `Auto: $${(trader.pnl / 1000).toFixed(0)}k PnL this week`
          });
        }
      }

      logger.info('TraderTracker: leaderboard fetched', {
        discovered: this.leaderboard.length,
        watching:   this.wallets.length
      });
    } catch (e) {
      logger.warn('TraderTracker: fetchLeaderboard failed', { error: e.message });
    }
  }

  // ── Position + trade fetch ─────────────────────────────────────────────────

  async fetchAllPositions() {
    if (this.wallets.length === 0) return;

    for (const wallet of this.wallets) {
      try {
        const [posRes, tradeRes] = await Promise.all([
          axios.get(`${DATA_API}/positions`, {
            params:  { user: wallet.address, limit: 50, sizeThreshold: 10 },
            timeout: 8000
          }),
          axios.get(`${DATA_API}/trades`, {
            params:  { user: wallet.address, limit: 20, takerOnly: false },
            timeout: 8000
          })
        ]);

        const positions = Array.isArray(posRes.data)   ? posRes.data   : [];
        const trades    = Array.isArray(tradeRes.data)  ? tradeRes.data : [];

        this.positions.set(wallet.address, positions);
        this.recentTrades.set(wallet.address, trades);

        // Push latest trade to signal feed
        if (trades.length > 0) {
          const latest = trades[0];
          const price  = (parseFloat(latest.price || 0) * 100).toFixed(0);
          stateStore.addNews({
            type:  'sharp_trader',
            agent: 'TraderTracker',
            text:  `${wallet.alias}: ${latest.side || '?'} "${(latest.title || '').slice(0, 40)}" @ ${price}%`
          });
        }
      } catch (e) {
        logger.debug('TraderTracker: fetch failed for wallet', {
          alias: wallet.alias, error: e.message
        });
      }

      // 500ms between wallets — respect rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    this.lastFetch = Date.now();
  }

  // ── Background polling ─────────────────────────────────────────────────────

  start() {
    setInterval(async () => {
      if (Date.now() - this.lastFetch < this.fetchInterval) return;
      await this.fetchAllPositions();
      // ~5% chance each interval — refreshes leaderboard roughly once per day
      if (Math.random() < 0.05) {
        await this.fetchLeaderboard();
      }
    }, 60000);
    logger.info('TraderTracker: background polling started (5 min interval)');
  }

  // ── Signal query — called per-market before Sonnet prompt ─────────────────

  getSignalForMarket(marketQuestion, conditionId) {
    const signals = [];
    const cutoff  = Date.now() - 48 * 60 * 60 * 1000;  // last 48 hours
    const qLower  = (marketQuestion || '').toLowerCase().slice(0, 25);

    // Recent trades in this market
    for (const [address, trades] of this.recentTrades) {
      const wallet = this.wallets.find(w => w.address === address);
      const alias  = wallet?.alias || address.slice(0, 8);

      const relevant = trades.filter(t =>
        (conditionId && t.conditionId === conditionId) ||
        (qLower && (t.title || '').toLowerCase().includes(qLower))
      ).filter(t => (t.timestamp || 0) * 1000 > cutoff);

      for (const t of relevant) {
        const age   = Math.round((Date.now() - t.timestamp * 1000) / 3_600_000);
        const spent = (parseFloat(t.size || 0) * parseFloat(t.price || 0)).toFixed(0);
        const pct   = (parseFloat(t.price || 0) * 100).toFixed(0);
        signals.push(`"${alias}" ${t.side || '?'} @ ${pct}% ($${spent}) ${age}h ago`);
      }
    }

    // Current holdings in this market
    for (const [address, positions] of this.positions) {
      const wallet = this.wallets.find(w => w.address === address);
      const alias  = wallet?.alias || address.slice(0, 8);

      const relevant = positions.filter(p =>
        (conditionId && p.conditionId === conditionId) ||
        (qLower && (p.title || '').toLowerCase().includes(qLower))
      ).filter(p => parseFloat(p.size || 0) >= 10);

      for (const p of relevant) {
        const avg = (parseFloat(p.avgPrice || 0) * 100).toFixed(0);
        const pnl = parseFloat(p.cashPnl || 0).toFixed(0);
        signals.push(`"${alias}" holds ${parseFloat(p.size || 0).toFixed(0)} shares @ avg ${avg}% | PnL $${pnl}`);
      }
    }

    return signals;
  }

  // ── Summary for dashboard ──────────────────────────────────────────────────

  getSummary() {
    return {
      walletsWatched:  this.wallets.length,
      leaderboardSize: this.leaderboard.length,
      lastFetch:       this.lastFetch,
      wallets: this.wallets.map(w => ({
        alias:        w.alias,
        address:      w.address.slice(0, 8) + '...',
        positions:    (this.positions.get(w.address)    || []).length,
        recentTrades: (this.recentTrades.get(w.address) || []).length
      })),
      leaderboard: this.leaderboard.slice(0, 10).map(t => ({
        alias:   t.alias,
        pnl:     t.pnl,
        trades:  t.trades,
        winRate: t.winRate
      }))
    };
  }
}

module.exports = new TraderTracker();
