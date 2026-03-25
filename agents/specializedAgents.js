'use strict';
const BaseAgent    = require('./baseAgent');
const polymarket   = require('../core/polymarketClient');

// ── CryptoAgent — 40s ─────────────────────────────────────────────────────────
class CryptoAgent extends BaseAgent {
  constructor() {
    super({ name: 'CryptoAgent', category: 'crypto', intervalSeconds: 40 });
  }

  async getMarkets() {
    const all = await polymarket.getActiveMarkets({ limit: 30 });
    const keywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain', 'defi', 'polygon', 'matic', 'solana', 'usdc', 'coin'];
    return all.filter(m => {
      const q = (m.question || m.title || '').toLowerCase();
      return keywords.some(k => q.includes(k));
    });
  }
}

// ── PoliticsAgent — 60s ───────────────────────────────────────────────────────
class PoliticsAgent extends BaseAgent {
  constructor() {
    super({ name: 'PoliticsAgent', category: 'politics', intervalSeconds: 60 });
  }

  async getMarkets() {
    const all = await polymarket.getActiveMarkets({ limit: 30 });
    const keywords = ['election', 'president', 'senate', 'congress', 'vote', 'political', 'democrat', 'republican', 'government', 'law', 'bill', 'policy', 'trump', 'biden', 'harris', 'elon'];
    return all.filter(m => {
      const q = (m.question || m.title || '').toLowerCase();
      return keywords.some(k => q.includes(k));
    });
  }
}

// ── EconomicsAgent — 75s ──────────────────────────────────────────────────────
class EconomicsAgent extends BaseAgent {
  constructor() {
    super({ name: 'EconomicsAgent', category: 'economics', intervalSeconds: 75 });
  }

  async getMarkets() {
    const all = await polymarket.getActiveMarkets({ limit: 30 });
    const keywords = ['gdp', 'inflation', 'fed', 'federal reserve', 'interest rate', 'cpi', 'recession', 'economy', 'unemployment', 'jobs', 'market cap', 's&p', 'nasdaq', 'dow', 'stock'];
    return all.filter(m => {
      const q = (m.question || m.title || '').toLowerCase();
      return keywords.some(k => q.includes(k));
    });
  }
}

// ── SportsAgent — 50s ─────────────────────────────────────────────────────────
class SportsAgent extends BaseAgent {
  constructor() {
    super({ name: 'SportsAgent', category: 'sports', intervalSeconds: 50 });
    this._sportsMeta = null;  // Cache sports metadata
  }

  async fetchSportsMeta() {
    if (this._sportsMeta) return this._sportsMeta;
    try {
      const axios = require('axios');
      const res = await axios.get('https://gamma-api.polymarket.com/sports', {
        timeout: 5000
      });
      this._sportsMeta = res.data || [];
      const logger = require('../core/logger');
      logger.debug('Sports metadata loaded', { count: this._sportsMeta.length });
      return this._sportsMeta;
    } catch (e) {
      return [];
    }
  }

  async buildContext(market) {
    const meta = await this.fetchSportsMeta();
    // Find matching sport for this market
    const sport = meta.find(s =>
      market.question?.toLowerCase().includes(s.sport?.toLowerCase())
    );
    if (sport?.resolution) {
      return `Resolution source: ${sport.resolution}\nOrdering: ${sport.ordering || 'N/A'}`;
    }
    return '';
  }

  async getMarkets() {
    const all = await polymarket.getActiveMarkets({ limit: 30 });
    const keywords = ['nfl', 'nba', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'tennis', 'golf', 'ufc', 'mma', 'championship', 'superbowl', 'world cup', 'playoffs', 'win', 'game'];
    return all.filter(m => {
      const q = (m.question || m.title || '').toLowerCase();
      return keywords.some(k => q.includes(k));
    });
  }
}

// ── WeatherAgent — 90s ────────────────────────────────────────────────────────
class WeatherAgent extends BaseAgent {
  constructor() {
    super({ name: 'WeatherAgent', category: 'weather', intervalSeconds: 90 });
  }

  async getMarkets() {
    const all = await polymarket.getActiveMarkets({ limit: 30 });
    const keywords = ['weather', 'hurricane', 'tornado', 'storm', 'temperature', 'rain', 'snow', 'flood', 'drought', 'climate', 'el nino', 'la nina', 'wildfire'];
    return all.filter(m => {
      const q = (m.question || m.title || '').toLowerCase();
      return keywords.some(k => q.includes(k));
    });
  }
}

// ── OddsAgent — 55s (high-volume misc) ───────────────────────────────────────
class OddsAgent extends BaseAgent {
  constructor() {
    super({ name: 'OddsAgent', category: 'odds', intervalSeconds: 55 });
  }

  async getMarkets() {
    // Targets highest-volume markets regardless of category
    const all = await polymarket.getActiveMarkets({ limit: 50 });
    // Sort by volume descending, take top results (excluding already-covered categories)
    const excluded = ['bitcoin', 'btc', 'ethereum', 'election', 'president', 'weather', 'hurricane'];
    return all
      .filter(m => {
        const q = (m.question || m.title || '').toLowerCase();
        return !excluded.some(k => q.includes(k));
      })
      .sort((a, b) => parseFloat(b.volume24hr || 0) - parseFloat(a.volume24hr || 0));
  }
}

module.exports = { CryptoAgent, PoliticsAgent, EconomicsAgent, SportsAgent, WeatherAgent, OddsAgent };
