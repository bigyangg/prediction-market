'use strict';
const axios      = require('axios');
const logger     = require('./logger');
const stateStore = require('./stateStore');

const DATA_API = 'https://data-api.polymarket.com';

// Known sharp traders — top performers on Polymarket leaderboard
// These are PUBLIC addresses visible on polymarket.com/leaderboard
// Add more via POST /api/traders/add or they are auto-discovered from leaderboard
const SHARP_WALLETS = [
  // Placeholder — replaced by leaderboard auto-discovery on boot
  // Add real wallets via POST /api/traders/add or wait for leaderboard fetch
  {
    address:     '0x0000000000000000000000000000000000000000',
    alias:       'Placeholder — leaderboard loading',
    description: 'Will be replaced by auto-discovery'
  }
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
      const res = await axios.get(`${DATA_API}/v1/leaderboard`, {
        params: {
          category:   'OVERALL',
          timePeriod: 'WEEK',
          orderBy:    'PNL',
          limit:      20
        },
        timeout: 10000
      });

      const traders = res.data || [];
      this.leaderboard = traders.map(t => ({
        address:      t.proxyWallet,
        alias:        t.userName || 'Trader #' + t.rank,
        pnl:          t.pnl      || 0,
        volume:       t.vol      || 0,
        rank:         parseInt(t.rank) || 99,
        profileImage: t.profileImage || null,
        xUsername:    t.xUsername || null,
        verifiedBadge: t.verifiedBadge || false
      })).filter(t => t.address);

      // Auto-add top 10 to watch list — replace placeholder if still present
      this.wallets = this.wallets.filter(w => !w.address.includes('000000'));
      const top10 = this.leaderboard.slice(0, 10);
      for (const trader of top10) {
        if (!this.wallets.find(w => w.address === trader.address)) {
          this.wallets.push({
            address:       trader.address,
            alias:         trader.alias,
            pnl:           trader.pnl,
            volume:        trader.volume,
            rank:          trader.rank,
            profileImage:  trader.profileImage,
            xUsername:     trader.xUsername,
            verifiedBadge: trader.verifiedBadge,
            description:   `Rank #${trader.rank} | PnL: $${(trader.pnl||0).toFixed(0)}`
          });
        }
      }

      logger.info('Leaderboard loaded', {
        traders: this.leaderboard.length,
        top:     this.leaderboard[0]?.alias
      });
    } catch (e) {
      logger.warn('TraderTracker: leaderboard unavailable — will retry in 5 min');
      logger.warn('Add wallet addresses manually via dashboard to start tracking');
    }
  }

  // ── Position + trade fetch ─────────────────────────────────────────────────

  async fetchAllPositions() {
    if (this.wallets.length === 0 || this.wallets.every(w => w.address.includes('000000'))) {
      logger.info('TraderTracker: no real wallets yet — skipping position fetch');
      return;
    }

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
        address:      w.address,
        pnl:          w.pnl || 0,
        volume:       w.volume || 0,
        rank:         w.rank || 99,
        profileImage: w.profileImage || null,
        xUsername:    w.xUsername || null,
        verifiedBadge: w.verifiedBadge || false,
        positions:    (this.positions.get(w.address)    || []).length,
        recentTrades: (this.recentTrades.get(w.address) || []).length
      })),
      leaderboard: this.leaderboard.slice(0, 10).map(t => ({
        alias:   t.alias,
        pnl:     t.pnl,
        rank:    t.rank,
        volume:  t.volume
      }))
    };
  }
}

module.exports = new TraderTracker();
