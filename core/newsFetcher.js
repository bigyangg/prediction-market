'use strict';
require('dotenv').config();
const axios  = require('axios');
const logger = require('./logger');

const CACHE_TTL_MS = 60 * 1000; // 60 seconds per SDD 3.4

// ── GNews free tier: 100 req/day ─────────────────────────────────────────────
const GNEWS_DAILY_BUDGET = 100;
const GNEWS_WARN_AT      = 80;
const GNEWS_HARD_STOP    = 95;

// GNews endpoints
const GNEWS_SEARCH    = 'https://gnews.io/api/v4/search';
const GNEWS_HEADLINES = 'https://gnews.io/api/v4/top-headlines';

// ── TinyFish constants ────────────────────────────────────────────────────────
const TF_API_URL            = 'https://api.tinyfish.io/v1/search';
const TF_TIMEOUT            = 12000;       // 12s — scraping is slow
const TF_MAX_FAIL           = 3;           // failures before cooldown
const TF_FAIL_COOLDOWN_MS   = 5 * 60 * 1000;   //  5 min cooldown after 3 failures
const TF_RATELIMIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown on 429

// ── Structured error logger ───────────────────────────────────────────────────
function fetchError(source, url, err) {
  const status = err.response?.status;
  const code   = err.code || (status ? `HTTP_${status}` : 'UNKNOWN');
  const detail = err.response?.data || err.message;

  if (status === 429) {
    logger.warn(`[NewsFetcher] ${source} RATE LIMITED`, { url, code, hint: 'Back off — daily quota may be exhausted' });
  } else if (status === 401 || status === 403) {
    logger.warn(`[NewsFetcher] ${source} AUTH FAILED`, { url, code, hint: 'Check API key in .env' });
  } else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    logger.warn(`[NewsFetcher] ${source} TIMED OUT`, { url, timeout: `${TF_TIMEOUT}ms` });
  } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
    logger.warn(`[NewsFetcher] ${source} UNREACHABLE`, { url, code, hint: 'Check internet connectivity' });
  } else {
    logger.warn(`[NewsFetcher] ${source} FAILED`, { url, code, detail });
  }
}

// ISO-8601 timestamp for N hours ago (for GNews `from` recency filter)
function hoursAgo(n) {
  return new Date(Date.now() - n * 3600 * 1000).toISOString().replace('.000', '');
}

class NewsFetcher {
  constructor() {
    this._cache    = new Map(); // cacheKey → { data, ts }
    this.gnewsKey  = process.env.GNEWS_API_KEY || null;

    // Daily GNews request budget tracker
    this._gnewsCallsToday = 0;
    this._gnewsDayStart   = this._todayUtc();

    // ── TinyFish state ────────────────────────────────────────────────────────
    this.tfKey          = process.env.TINYFISH_API_KEY || null;
    this._tfDisabled    = false;   // permanent disable (invalid key)
    this._tfCooldownUntil = 0;    // timestamp when cooldown expires
    this._tfFailCount   = 0;      // consecutive failures counter

    if (this.gnewsKey) {
      logger.info('[NewsFetcher] GNews API key loaded — 100 req/day budget active');
    } else {
      logger.warn('[NewsFetcher] No GNEWS_API_KEY — GNews calls will be rate-limited', {
        hint: 'Add GNEWS_API_KEY to .env for full news coverage'
      });
    }

    if (this.tfKey) {
      logger.info('[NewsFetcher] TinyFish API key loaded — Layer 1 enrichment active');
    } else {
      logger.info('[NewsFetcher] No TINYFISH_API_KEY — using Layer 2 free APIs only');
    }
  }

  _todayUtc() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }

  // ── Budget tracking ───────────────────────────────────────────────────────

  _gnewsBudgetOk() {
    const today = this._todayUtc();
    if (today !== this._gnewsDayStart) {
      this._gnewsCallsToday = 0;
      this._gnewsDayStart   = today;
      logger.info('[NewsFetcher] GNews daily budget reset (midnight UTC)');
    }

    if (this._gnewsCallsToday >= GNEWS_HARD_STOP) {
      logger.error('[NewsFetcher] GNews daily budget EXHAUSTED — skipping GNews calls', {
        used: this._gnewsCallsToday, limit: GNEWS_DAILY_BUDGET,
        hint: 'Budget resets at midnight UTC'
      });
      return false;
    }

    if (this._gnewsCallsToday >= GNEWS_WARN_AT) {
      logger.warn('[NewsFetcher] GNews budget WARNING', {
        used: this._gnewsCallsToday, limit: GNEWS_DAILY_BUDGET,
        remaining: GNEWS_DAILY_BUDGET - this._gnewsCallsToday
      });
    }
    return true;
  }

  _gnewsIncrement(cacheHit) {
    if (!cacheHit) {
      this._gnewsCallsToday++;
      logger.info(`[NewsFetcher] GNews request #${this._gnewsCallsToday}/${GNEWS_DAILY_BUDGET} today`);
    }
  }

  // ── 60s TTL cache (SDD 3.4) ───────────────────────────────────────────────

  _cacheKey(url, params) {
    return url + ':' + JSON.stringify(params);
  }

  _cacheGet(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      this._cache.delete(key);
      return null;
    }
    return entry.data;
  }

  _cacheSet(key, data) {
    this._cache.set(key, { data, ts: Date.now() });
    if (this._cache.size > 200) {
      const oldest = [...this._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      this._cache.delete(oldest[0]);
    }
  }

  async _fetch(source, url, params = {}) {
    const key = this._cacheKey(url, params);
    const hit  = this._cacheGet(key);
    if (hit) return hit;

    try {
      const res = await axios.get(url, { params, timeout: 8000 });
      this._cacheSet(key, res.data);
      return res.data;
    } catch (err) {
      fetchError(source, url, err);
      return null;
    }
  }

  // ── GNews core caller — enforces budget + adds token ─────────────────────

  async _gnews(params) {
    if (!this._gnewsBudgetOk()) return null;

    const fullParams = { lang: 'en', max: 10, ...params };
    if (this.gnewsKey) fullParams.token = this.gnewsKey;

    const url = fullParams._endpoint || GNEWS_SEARCH;
    delete fullParams._endpoint;

    const key    = this._cacheKey(url, fullParams);
    const cached = this._cacheGet(key);
    this._gnewsIncrement(!!cached);
    if (cached) return cached;

    try {
      const res = await axios.get(url, { params: fullParams, timeout: 8000 });
      this._cacheSet(key, res.data);
      return res.data;
    } catch (err) {
      fetchError('GNews', url, err);
      return null;
    }
  }

  _mapArticles(data) {
    if (!data?.articles) return [];
    return data.articles.map(a => ({
      title:       a.title,
      description: (a.description || '').slice(0, 250),
      source:      a.source?.name || 'GNews',
      publishedAt: a.publishedAt
    }));
  }

  // ── TinyFish Layer 1 ──────────────────────────────────────────────────────

  isTFAvailable() {
    if (!this.tfKey)        return false;
    if (this._tfDisabled)   return false;
    if (Date.now() < this._tfCooldownUntil) return false;
    return true;
  }

  recordTFSuccess() {
    this._tfFailCount    = 0;
    this._tfCooldownUntil = 0;
  }

  recordTFFailure(err) {
    const status = err?.response?.status;

    // 401/403 → invalid key → permanent disable
    if (status === 401 || status === 403) {
      this._tfDisabled = true;
      logger.warn('[NewsFetcher] TinyFish key invalid — permanently disabled', {
        hint: 'Update TINYFISH_API_KEY in .env and restart'
      });
      return;
    }

    // 429 → rate limited → 10 min cooldown
    if (status === 429) {
      this._tfCooldownUntil = Date.now() + TF_RATELIMIT_COOLDOWN_MS;
      logger.warn('[NewsFetcher] TinyFish RATE LIMITED — 10 min cooldown', {
        resumesAt: new Date(this._tfCooldownUntil).toISOString()
      });
      return;
    }

    // Other errors → increment fail count → 5 min cooldown after 3 failures
    this._tfFailCount++;
    logger.warn(`[NewsFetcher] TinyFish failure ${this._tfFailCount}/${TF_MAX_FAIL}`, {
      error: err?.message || 'unknown'
    });
    if (this._tfFailCount >= TF_MAX_FAIL) {
      this._tfCooldownUntil = Date.now() + TF_FAIL_COOLDOWN_MS;
      this._tfFailCount     = 0;
      logger.warn('[NewsFetcher] TinyFish 3x failures — 5 min cooldown', {
        resumesAt: new Date(this._tfCooldownUntil).toISOString()
      });
    }
  }

  // Batch scrape/search via TinyFish
  // queries: string[] — natural-language search queries
  // Returns: [{ query, results: [{ title, snippet, url }] }] or null
  async tinyfishBatch(queries) {
    if (!this.isTFAvailable()) return null;

    const cacheKey = 'tf:' + queries.join('|');
    const cached   = this._cacheGet(cacheKey);
    if (cached) return cached;

    try {
      const res = await axios.post(
        TF_API_URL,
        { queries, max_results: 5 },
        {
          headers: {
            'Authorization': `Bearer ${this.tfKey}`,
            'Content-Type':  'application/json'
          },
          timeout: TF_TIMEOUT
        }
      );
      const data = res.data?.results || res.data;
      if (!data) throw new Error('Empty TinyFish response');

      this._cacheSet(cacheKey, data);
      this.recordTFSuccess();
      logger.info(`[NewsFetcher] TinyFish OK — ${queries.length} queries`);
      return data;
    } catch (err) {
      fetchError('TinyFish', TF_API_URL, err);
      this.recordTFFailure(err);
      return null;
    }
  }

  // Flatten TinyFish batch results into a list of article-like objects
  _mapTFResults(batch) {
    if (!batch) return [];
    const items = Array.isArray(batch) ? batch : Object.values(batch);
    const out = [];
    for (const group of items) {
      const results = group?.results || (Array.isArray(group) ? group : []);
      for (const r of results) {
        out.push({
          title:       r.title || r.heading || '',
          description: (r.snippet || r.body || r.content || '').slice(0, 300),
          source:      r.source || r.domain || 'TinyFish',
          publishedAt: r.publishedAt || r.date || null
        });
      }
    }
    return out;
  }

  // ── TinyFish per-category queries ─────────────────────────────────────────

  async tfCrypto() {
    return this.tinyfishBatch([
      'bitcoin ethereum crypto market news today',
      'SEC crypto ETF approval regulation 2025',
      'crypto exchange hack exploit vulnerability'
    ]);
  }

  async tfPolitics() {
    return this.tinyfishBatch([
      'US election results latest news today',
      'senate house congress bill legislation passed',
      'president executive order announcement'
    ]);
  }

  async tfEconomics() {
    return this.tinyfishBatch([
      'federal reserve interest rate decision today',
      'CPI inflation jobs report GDP data release',
      'recession stock market outlook analysts forecast'
    ]);
  }

  async tfSports() {
    return this.tinyfishBatch([
      'sports championship scores results today',
      'NBA NFL MLB NHL winner playoffs upset',
      'tournament bracket outcome final score'
    ]);
  }

  async tfWeather() {
    return this.tinyfishBatch([
      'hurricane tropical storm category forecast track',
      'tornado wildfire flood extreme weather warning',
      'NOAA NWS severe weather alert update'
    ]);
  }

  async tfOdds() {
    return this.tinyfishBatch([
      'polymarket prediction market trending today',
      'breaking world news top stories',
      'major event outcome result confirmed'
    ]);
  }

  // ── TinyFish status for dashboard ─────────────────────────────────────────

  getTFStatus() {
    if (!this.tfKey)       return { state: 'disabled', label: 'TF disabled' };
    if (this._tfDisabled)  return { state: 'off',      label: 'TF off (bad key)' };
    if (Date.now() < this._tfCooldownUntil) {
      const secsLeft = Math.ceil((this._tfCooldownUntil - Date.now()) / 1000);
      return { state: 'cooldown', label: `TF cooldown (${secsLeft}s)` };
    }
    return { state: 'live', label: 'TF live' };
  }

  // ── Free-API source fetchers (Layer 2 — always run) ───────────────────────

  async fetchCryptoNews() {
    const data = await this._fetch(
      'CryptoCompare',
      'https://min-api.cryptocompare.com/data/v2/news/',
      { lang: 'EN', sortOrder: 'latest' }
    );
    if (!data?.Data) {
      logger.warn('[NewsFetcher.fetchCryptoNews] Empty or malformed CryptoCompare response');
      return [];
    }
    return data.Data.slice(0, 6).map(a => ({
      title:  a.title,
      body:   (a.body || '').slice(0, 250),
      source: 'CryptoCompare',
      ts:     a.published_on
    }));
  }

  async fetchCryptoPrices() {
    const data = await this._fetch(
      'CoinGecko',
      'https://api.coingecko.com/api/v3/simple/price',
      {
        ids:                'bitcoin,ethereum,matic-network,usd-coin,solana,chainlink',
        vs_currencies:      'usd',
        include_24hr_change: true,
        include_market_cap:  true
      }
    );
    if (!data) {
      logger.warn('[NewsFetcher.fetchCryptoPrices] No price data from CoinGecko');
      return {};
    }
    return data;
  }

  async fetchWeather(lat = 51.5, lon = -0.1) {
    const data = await this._fetch(
      'OpenMeteo',
      'https://api.open-meteo.com/v1/forecast',
      {
        latitude:        lat,
        longitude:       lon,
        current_weather: true,
        hourly:          'temperature_2m,precipitation_probability,windspeed_10m',
        forecast_days:   2
      }
    );
    if (!data?.current_weather) {
      logger.warn('[NewsFetcher.fetchWeather] Missing current_weather from Open-Meteo', { lat, lon });
      return null;
    }
    return {
      temp:      data.current_weather.temperature,
      windspeed: data.current_weather.windspeed,
      code:      data.current_weather.weathercode
    };
  }

  // ── GNews targeted fetchers (Layer 2 — all use recency filter) ───────────

  async fetchGNewsCrypto() {
    const data = await this._gnews({
      q:       'bitcoin ethereum crypto regulation SEC ETF exchange',
      sortby:  'publishedAt',
      from:    hoursAgo(12)
    });
    return this._mapArticles(data);
  }

  async fetchGNewsPolitics() {
    const [breaking, specific] = await Promise.all([
      this._gnews({
        _endpoint: GNEWS_HEADLINES,
        category:  'nation',
        country:   'us',
        sortby:    'publishedAt'
      }),
      this._gnews({
        q:      'election president senate congress legislation vote bill',
        sortby: 'publishedAt',
        from:   hoursAgo(6)
      })
    ]);
    return [
      ...this._mapArticles(breaking).slice(0, 5),
      ...this._mapArticles(specific).slice(0, 5)
    ];
  }

  async fetchGNewsEconomics() {
    const [businessNews, macroNews] = await Promise.all([
      this._gnews({
        _endpoint: GNEWS_HEADLINES,
        category:  'business',
        country:   'us',
        sortby:    'publishedAt'
      }),
      this._gnews({
        q:      'federal reserve interest rate inflation CPI GDP unemployment jobs report',
        sortby: 'publishedAt',
        from:   hoursAgo(12)
      })
    ]);
    return [
      ...this._mapArticles(businessNews).slice(0, 5),
      ...this._mapArticles(macroNews).slice(0, 5)
    ];
  }

  async fetchGNewsSports() {
    const [headlines, specific] = await Promise.all([
      this._gnews({
        _endpoint: GNEWS_HEADLINES,
        category:  'sports',
        sortby:    'publishedAt'
      }),
      this._gnews({
        q:      'championship winner score result upset playoffs tournament',
        sortby: 'publishedAt',
        from:   hoursAgo(8)
      })
    ]);
    return [
      ...this._mapArticles(headlines).slice(0, 5),
      ...this._mapArticles(specific).slice(0, 5)
    ];
  }

  async fetchGNewsWeather() {
    const data = await this._gnews({
      q:      'hurricane tornado storm flood wildfire drought extreme weather forecast',
      sortby: 'publishedAt',
      from:   hoursAgo(24)
    });
    return this._mapArticles(data);
  }

  async fetchGNewsGeneral() {
    const data = await this._gnews({
      _endpoint: GNEWS_HEADLINES,
      category:  'general',
      sortby:    'publishedAt'
    });
    return this._mapArticles(data);
  }

  // ── Category context builder — layered: TF (L1) + free APIs (L2) ─────────

  async getContextForCategory(category) {
    const ctx = {};
    const fn  = `getContextForCategory(${category})`;

    try {
      switch (category) {

        case 'crypto': {
          // Layer 2 always: CryptoCompare + CoinGecko + GNews regulatory
          const [ccNews, prices, gnewsCrypto, tfBatch] = await Promise.all([
            this.fetchCryptoNews(),
            this.fetchCryptoPrices(),
            this.fetchGNewsCrypto(),
            this.tfCrypto()       // Layer 1: enriched search (null if unavailable)
          ]);
          ctx.cryptoNews     = ccNews;
          ctx.cryptoPrices   = prices;
          ctx.regulatoryNews = gnewsCrypto;
          if (tfBatch) {
            ctx.enrichedNews = this._mapTFResults(tfBatch).slice(0, 8);
            logger.info('[NewsFetcher] TinyFish enrichment merged for crypto');
          }
          break;
        }

        case 'weather': {
          const [weather, gnewsWeather, tfBatch] = await Promise.all([
            this.fetchWeather(),
            this.fetchGNewsWeather(),
            this.tfWeather()
          ]);
          ctx.weather     = weather;
          ctx.weatherNews = gnewsWeather;
          if (tfBatch) {
            ctx.enrichedNews = this._mapTFResults(tfBatch).slice(0, 8);
            logger.info('[NewsFetcher] TinyFish enrichment merged for weather');
          }
          break;
        }

        case 'politics': {
          const [headlines, tfBatch] = await Promise.all([
            this.fetchGNewsPolitics(),
            this.tfPolitics()
          ]);
          ctx.headlines = headlines;
          if (tfBatch) {
            ctx.enrichedNews = this._mapTFResults(tfBatch).slice(0, 8);
            logger.info('[NewsFetcher] TinyFish enrichment merged for politics');
          }
          break;
        }

        case 'economics': {
          const [headlines, tfBatch] = await Promise.all([
            this.fetchGNewsEconomics(),
            this.tfEconomics()
          ]);
          ctx.headlines = headlines;
          if (tfBatch) {
            ctx.enrichedNews = this._mapTFResults(tfBatch).slice(0, 8);
            logger.info('[NewsFetcher] TinyFish enrichment merged for economics');
          }
          break;
        }

        case 'sports': {
          const [headlines, tfBatch] = await Promise.all([
            this.fetchGNewsSports(),
            this.tfSports()
          ]);
          ctx.sportsHeadlines = headlines;
          if (tfBatch) {
            ctx.enrichedNews = this._mapTFResults(tfBatch).slice(0, 8);
            logger.info('[NewsFetcher] TinyFish enrichment merged for sports');
          }
          break;
        }

        case 'odds':
        default: {
          const [general, crypto, prices, tfBatch] = await Promise.all([
            this.fetchGNewsGeneral(),
            this.fetchCryptoNews(),
            this.fetchCryptoPrices(),
            this.tfOdds()
          ]);
          ctx.headlines    = general;
          ctx.cryptoNews   = crypto;
          ctx.cryptoPrices = prices;
          if (tfBatch) {
            ctx.enrichedNews = this._mapTFResults(tfBatch).slice(0, 8);
            logger.info('[NewsFetcher] TinyFish enrichment merged for odds');
          }
          break;
        }
      }
    } catch (err) {
      logger.error(`[NewsFetcher.${fn}] Unexpected error`, {
        error: err.message,
        stack: err.stack?.split('\n')[1],
        hint:  'Context will be partial — Claude will have less signal this cycle'
      });
    }

    // Log what was gathered
    const keys  = Object.keys(ctx);
    const sizes = keys.map(k => {
      const v = ctx[k];
      return `${k}:${Array.isArray(v) ? v.length + ' items' : typeof v}`;
    }).join(', ');
    logger.info(`[NewsFetcher.${fn}] Context built`, {
      sources: sizes,
      tf:      this.getTFStatus().state
    });

    return ctx;
  }

  // ── Budget / status accessors ─────────────────────────────────────────────

  getBudgetStatus() {
    return {
      used:      this._gnewsCallsToday,
      limit:     GNEWS_DAILY_BUDGET,
      remaining: GNEWS_DAILY_BUDGET - this._gnewsCallsToday,
      pct:       Math.round((this._gnewsCallsToday / GNEWS_DAILY_BUDGET) * 100)
    };
  }
}

module.exports = new NewsFetcher();
