'use strict';
require('dotenv').config();
// @polymarket/clob-client is ESM-only — loaded via dynamic import in init()
const { Wallet } = require('ethers'); // v5 — Wallet only, no RPC
const axios                           = require('axios');
const WebSocket                       = require('ws');
const logger                          = require('./logger');
const stateStore                      = require('./stateStore');

const GAMMA_API     = process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com';
const DATA_API      = 'https://data-api.polymarket.com';
const USER_WS_URL   = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
const GEOBLOCK_URL  = 'https://polymarket.com/api/geoblock';
const CLOB_HOST     = process.env.CLOB_API_URL  || 'https://clob.polymarket.com';
const CHAIN_ID      = 137; // Polygon mainnet

// ── Market normalizer ────────────────────────────────────────────────────────
function mapMarket(m) {
  if (!m?.id) return null;

  const safeParseArr = (str) => {
    try { return str ? JSON.parse(str) : []; } catch { return []; }
  };

  const tokenIds  = safeParseArr(m.clobTokenIds);   // ["tokenA","tokenB"]
  const prices    = safeParseArr(m.outcomePrices);  // ["0.6","0.4"]
  const outcomes  = safeParseArr(m.outcomes);       // ["Yes","No"]

  const liquidity  = parseFloat(m.liquidityNum  ?? m.liquidityClob  ?? m.liquidity  ?? 0);
  const volume24hr = parseFloat(m.volume24hr    ?? m.volumeNum      ?? 0);

  const lastPrice = parseFloat(m.lastTradePrice ?? m.bestAsk ?? prices[0] ?? 0.5);

  const tokens = tokenIds.map((id, i) => ({
    token_id: id,
    outcome:  outcomes[i] || (i === 0 ? 'Yes' : 'No')
  }));

  return {
    id:              m.id,
    conditionId:     m.conditionId,
    question:        m.question || 'Unknown',
    category:        m.categories?.[0]?.label || m.category || 'General',
    endDate:         m.endDate || m.endDateIso,
    volume24hr,
    liquidity,
    bestAsk:         parseFloat(m.bestAsk  ?? lastPrice + 0.01),
    bestBid:         parseFloat(m.bestBid  ?? lastPrice - 0.01),
    lastPrice,
    marketProb:      Math.round(lastPrice * 100),
    tokens,
    tokenIds,
    // Pre-parsed arrays — downstream code can use these directly without JSON.parse
    clobTokenIds:    tokenIds,
    outcomePrices:   prices,
    outcomes,
    active:          m.active !== false,
    closed:          m.closed === true,
    acceptingOrders: m.acceptingOrders !== false,
    negRisk:         m.negRisk || false,
    minimumTickSize: m.orderPriceMinTickSize?.toString() || '0.01',
    slug:            m.slug || '',
    spread:          m.spread || null
  };
}

function filterAndReturn(markets, limit) {
  return markets
    .filter(m =>
      m.volume24hr > 100 &&
      m.liquidity  > 200 &&
      !m.closed &&
      m.active &&
      m.acceptingOrders &&
      m.marketProb >= 3 &&
      m.marketProb <= 97 &&
      m.question !== 'Unknown' &&
      m.tokenIds.length > 0
    )
    .filter(m => !/\b5-?min/i.test(m.question))
    .filter(m => !/\b15-?min/i.test(m.question))
    .slice(0, limit);
}

// ── Structured error logger ───────────────────────────────────────────────────
function apiError(fn, err, extra = {}) {
  const status = err.response?.status || err.code || 'UNKNOWN';
  const detail = err.response?.data   || err.message;
  if (status === 401 || status === 403) {
    logger.error(`[PolymarketClient.${fn}] AUTH FAILED`, { status, detail, ...extra, hint: 'Check POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS' });
  } else if (status === 429) {
    logger.error(`[PolymarketClient.${fn}] RATE LIMITED`, { status, ...extra, hint: 'Back off or reduce scan frequency' });
  } else if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    logger.warn(`[PolymarketClient.${fn}] TIMED OUT`, extra);
  } else {
    logger.warn(`[PolymarketClient.${fn}] FAILED`, { status, detail, ...extra });
  }
}

class PolymarketClient {
  constructor() {
    this.host       = CLOB_HOST;
    this.chainId    = CHAIN_ID;
    this.sigType    = parseInt(process.env.POLYMARKET_SIGNATURE_TYPE) || 1;
    this.funder     = process.env.POLYMARKET_FUNDER_ADDRESS || null;
    this.privateKey = process.env.POLYMARKET_PRIVATE_KEY    || null;
    this.wallet     = null;
    this.client     = null;   // authenticated L2 ClobClient
    this.readOnly   = true;
    this.apiCreds   = null;   // { apiKey, secret, passphrase }

    // ESM module refs — populated by dynamic import in init()
    this.ClobClient  = null;
    this.Side        = null;
    this.OrderType   = null;
  }

  _isPlaceholder(val) {
    return !val || val.startsWith('your_') || val.startsWith('your-');
  }

  _truncate(addr) {
    if (!addr) return 'N/A';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // ── Init sequence ─────────────────────────────────────────────────────────

  async init() {
    // Dynamic import — @polymarket/clob-client is ESM-only (Node 22+ requires this)
    try {
      const clobModule  = await import('@polymarket/clob-client');
      this.ClobClient   = clobModule.ClobClient;
      this.Side         = clobModule.Side;
      this.OrderType    = clobModule.OrderType;
      logger.info('[PolymarketClient.init] clob-client loaded via dynamic import');
    } catch (err) {
      logger.error('[PolymarketClient.init] Failed to load @polymarket/clob-client', {
        error: err.message,
        hint:  'Run: npm install @polymarket/clob-client'
      });
      stateStore.readOnly = true;
      this.readOnly = true;
      return;
    }

    // Step 1 — Geoblock check
    try {
      const res = await axios.get(GEOBLOCK_URL, { timeout: 8000 });
      if (res.data?.blocked === true) {
        logger.error('[PolymarketClient.init] GEOBLOCK: Trading not available in your region', {
          country: res.data.country || 'unknown',
          hint: 'Polymarket is geo-restricted — use a compliant jurisdiction'
        });
        stateStore.readOnly = true;
        this.readOnly = true;
        return;
      }
      logger.info('[PolymarketClient.init] Geoblock check passed', {
        country: res.data?.country || 'unknown'
      });
    } catch (err) {
      // Non-fatal — continue if geoblock endpoint is unreachable
      logger.warn('[PolymarketClient.init] Geoblock check skipped', {
        error: err.message, hint: 'Could not reach geoblock API — proceeding'
      });
    }

    // Step 2 — Wallet setup
    if (this._isPlaceholder(this.privateKey)) {
      logger.warn('[PolymarketClient.init] No POLYMARKET_PRIVATE_KEY — READ-ONLY mode', {
        hint: 'Set POLYMARKET_PRIVATE_KEY in .env to enable live trading'
      });
      stateStore.readOnly = true;
      this.readOnly = true;
      return;
    }

    try {
      this.wallet = new Wallet(this.privateKey);
      logger.info('[PolymarketClient.init] Wallet loaded', {
        address: this._truncate(this.wallet.address)
      });
    } catch (err) {
      logger.error('[PolymarketClient.init] Wallet creation FAILED', {
        error: err.message,
        hint: 'Check POLYMARKET_PRIVATE_KEY format — 32-byte hex, with or without 0x prefix'
      });
      stateStore.readOnly = true;
      this.readOnly = true;
      return;
    }

    // Step 3 — Create single client (Python: ClobClient(key, chain_id, sig_type, funder))
    // funderAddress is CRITICAL for POLY_PROXY — without it the CLOB looks up keys
    // for the signing address (0x2C76d...) instead of the funder (0x2045...)
    const client = new this.ClobClient(
      this.host,
      this.chainId,
      this.wallet,
      undefined,               // no creds yet
      this.sigType,            // 1 = POLY_PROXY
      this.funder || undefined
    );

    // Step 4 — Derive creds then create L2 client with { key } field
    // JS SDK constructor expects "key" not "apiKey" — confirmed via test-auth.js
    let creds;
    try {
      try {
        creds = await client.deriveApiKey(0);
        logger.info('[PolymarketClient.init] deriveApiKey success', {
          key: creds.key ? creds.key.slice(0, 8) + '...' : 'MISSING'
        });
      } catch (e) {
        logger.warn('[PolymarketClient.init] derive failed, creating new key', { error: e.message });
        creds = await client.createApiKey(0);
        logger.info('[PolymarketClient.init] createApiKey success', {
          key: creds.key ? creds.key.slice(0, 8) + '...' : 'MISSING'
        });
      }
    } catch (err) {
      apiError('init.deriveApiKey', err, { address: this._truncate(this.wallet?.address) });
      stateStore.readOnly = true;
      this.readOnly = true;
      return;
    }

    const l2client = new this.ClobClient(
      this.host,
      this.chainId,
      this.wallet,
      { key: creds.key, secret: creds.secret, passphrase: creds.passphrase },
      this.sigType,
      this.funder || undefined
    );

    this.client   = l2client;
    this.readOnly = false;
    stateStore.readOnly = false;

    // Store for WebSocket auth (WS uses apiKey field name)
    this.apiCreds = {
      apiKey:     creds.key,
      secret:     creds.secret,
      passphrase: creds.passphrase
    };

    logger.info('[PolymarketClient.init] L2 client ready', {
      key: creds.key ? creds.key.slice(0, 8) + '...' : 'MISSING'
    });

    // Step 5 — Verify auth with balance check
    try {
      const bal     = await l2client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const balance = (parseInt(bal?.balance || 0) / 1e6).toFixed(2);
      logger.info(`[PolymarketClient.init] Auth verified — USDC balance: $${balance}`);
      stateStore.setWallet(this.funder || this.wallet.address, parseFloat(balance));
    } catch (err) {
      logger.error('[PolymarketClient.init] Balance check failed', {
        error:  err.message,
        status: err.response?.status
      });
    }

    await this.ensureAllowance();

    // Step 6 — Heartbeat (CRITICAL — keeps WS session alive)
    let heartbeatId = '';
    setInterval(async () => {
      try {
        const resp = await this.client.postHeartbeat(heartbeatId);
        heartbeatId = resp?.heartbeat_id || heartbeatId;
      } catch (e) {
        logger.warn('[PolymarketClient] Heartbeat failed — retrying next interval', { error: e.message });
      }
    }, 5000);
    logger.info('[PolymarketClient.init] Heartbeat started (5s interval)');

    // Step 7 — User WebSocket for instant trade confirmation
    this.connectUserWebSocket();
  }

  // ── USDC Balance ──────────────────────────────────────────────────────────

  async getUSDCBalance() {
    if (this.readOnly || !this.client) return '0.00';
    try {
      // Use CLOB API balance endpoint — no RPC needed
      const bal = await this.client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      return parseFloat(bal?.balance || 0).toFixed(2);
    } catch (e) {
      logger.debug('getUSDCBalance failed', { error: e.message });
      return '0.00';
    }
  }

  async refreshWallet() {
    const balance = await this.getUSDCBalance();
    const addr    = this.funder || this.wallet?.address || null;
    stateStore.setWallet(addr, parseFloat(balance));
    return { address: addr, balance };
  }

  // ── Data API — Real Positions ────────────────────────────────────────────

  async getRealPositions() {
    const fn   = 'getRealPositions';
    const addr = this.funder || this.wallet?.address;
    if (!addr) return [];
    try {
      const res = await axios.get(`${DATA_API}/positions`, {
        params: { user: addr, sizeThreshold: 0.01, limit: 100, sortBy: 'CASHPNL', sortDirection: 'DESC' },
        timeout: 10000
      });
      const positions = Array.isArray(res.data) ? res.data : [];
      logger.info(`[PolymarketClient.${fn}] ${positions.length} positions loaded`);
      return positions;
    } catch (err) {
      apiError(fn, err, { address: this._truncate(addr) });
      return [];
    }
  }

  async getRealTrades(limit = 50) {
    const fn   = 'getRealTrades';
    const addr = this.funder || this.wallet?.address;
    if (!addr) return [];
    try {
      const res = await axios.get(`${DATA_API}/trades`, {
        params: { user: addr, limit, takerOnly: false },
        timeout: 10000
      });
      return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      apiError(fn, err, { address: this._truncate(addr) });
      return [];
    }
  }

  async getRealPnL() {
    const positions = await this.getRealPositions();
    const totalCashPnl      = positions.reduce((s, p) => s + (parseFloat(p.cashPnl)      || 0), 0);
    const totalCurrentValue = positions.reduce((s, p) => s + (parseFloat(p.currentValue) || 0), 0);
    const winningPositions  = positions.filter(p => parseFloat(p.cashPnl) > 0).length;
    return {
      totalCashPnl:      parseFloat(totalCashPnl.toFixed(4)),
      totalCurrentValue: parseFloat(totalCurrentValue.toFixed(4)),
      openPositionCount: positions.length,
      winningPositions,
      positions
    };
  }

  // ── User WebSocket — instant trade confirmation ────────────────────────────

  connectUserWebSocket() {
    if (!this.apiCreds || this.readOnly) return;
    this._wsRetryCount = 0;

    const connect = () => {
      const ws = new WebSocket(USER_WS_URL);

      ws.on('open', () => {
        this._wsRetryCount = 0; // reset on successful connect
        logger.info('[PolymarketClient.userWS] Connected — subscribing to user events');
        ws.send(JSON.stringify({
          auth: {
            apiKey:     this.apiCreds.apiKey,
            secret:     this.apiCreds.secret,
            passphrase: this.apiCreds.passphrase
          },
          type: 'user'
        }));
      });

      ws.on('message', (raw) => {
        try {
          const msgs = JSON.parse(raw.toString());
          const events = Array.isArray(msgs) ? msgs : [msgs];
          for (const evt of events) {
            if (evt.event_type === 'trade' && evt.status === 'CONFIRMED') {
              logger.info('[PolymarketClient.userWS] Trade CONFIRMED on-chain', {
                side:   evt.side,
                size:   evt.size,
                price:  evt.price,
                market: (evt.market_id || '').slice(0, 20)
              });
              // Trigger immediate Data API poll — don't wait 30s
              stateStore.emit('trigger_data_poll');
            } else if (evt.event_type === 'order') {
              logger.info('[PolymarketClient.userWS] Order event', {
                status: evt.status,
                side:   evt.side,
                size:   evt.size
              });
            }
          }
        } catch { /* ignore malformed frames */ }
      });

      ws.on('close', () => {
        this._wsRetryCount++;
        if (this._wsRetryCount > 5) {
          logger.warn('[PolymarketClient.userWS] Giving up after 5 retries — order fills via REST polling only');
          return;
        }
        const backoffMs = Math.min(30000, 3000 * Math.pow(2, this._wsRetryCount - 1));
        logger.warn('[PolymarketClient.userWS] Disconnected — reconnecting', {
          attempt: this._wsRetryCount,
          backoffMs
        });
        setTimeout(connect, backoffMs);
      });

      ws.on('error', (err) => {
        logger.warn('[PolymarketClient.userWS] Error', { error: err.message });
        // close handler will reconnect with backoff
      });
    };

    connect();
    logger.info('[PolymarketClient.userWS] User WebSocket started');
  }

  // ── Gamma API — Active Markets ────────────────────────────────────────────

  async getActiveMarkets({ limit = 50 } = {}) {
    const persistence = require('./persistence');
    const ttl = parseInt(process.env.MARKET_CACHE_TTL_MINUTES) || 10;

    const cached = await persistence.getCachedMarkets(ttl);
    if (cached && cached.length > 0) {
      logger.info('getActiveMarkets: serving from Supabase cache', { count: cached.length });
      return cached;
    }

    try {
      const res = await axios.get('https://gamma-api.polymarket.com/markets', {
        params: { active: true, closed: false, limit: 100, order: 'volume24hr', ascending: false },
        timeout: 15000,
        headers: { 'Accept': 'application/json' }
      });

      const raw = Array.isArray(res.data) ? res.data : [];
      logger.info('Gamma API response', { count: raw.length, first: raw[0]?.question?.slice(0, 50) });

      const markets = raw.map(m => mapMarket(m)).filter(Boolean);
      const filtered = filterAndReturn(markets, limit);

      // Cache results to Supabase for next restart
      persistence.cacheMarkets(filtered).catch(() => {});
      return filtered;
    } catch (err) {
      logger.error('getActiveMarkets failed', {
        status:       err.response?.status,
        message:      err.message,
        responseData: JSON.stringify(err.response?.data)?.slice(0, 300)
      });
      return [];
    }
  }

  // ── Allowance ─────────────────────────────────────────────────────────────

  async ensureAllowance() {
    if (this.readOnly || !this.client) return;
    try {
      await this.client.updateBalanceAllowance({ asset_type: 'COLLATERAL' });
      logger.info('[PolymarketClient] USDC allowance set');
    } catch (e) {
      logger.debug('[PolymarketClient] allowance update', { error: e.message });
    }
  }

  // ── Order Placement ───────────────────────────────────────────────────────

  async placeOrder({ tokenId, side, usdcAmount, marketQuestion }) {
    const fn  = 'placeOrder';
    const ctx = { tokenId, side, usdcAmount, market: (marketQuestion || '').slice(0, 60) };

    if (this.readOnly) {
      const simId = `sim_${Date.now()}`;
      logger.info(`[PolymarketClient.${fn}] READ-ONLY: simulated order`, { ...ctx, orderId: simId });
      return { simulated: true, orderId: simId };
    }

    if (!this.client) {
      logger.error(`[PolymarketClient.${fn}] No authenticated client — cannot place order`, ctx);
      throw new Error('CLOB client not initialized');
    }

    await this.ensureAllowance();

    try {
      // Step 1 — Get market params
      const [tickSize, negRisk] = await Promise.all([
        this.client.getTickSize(tokenId).catch(() => 0.01),
        this.client.getNegRisk(tokenId).catch(() => false)
      ]);

      // Step 2 — Get orderbook for best price
      const book    = await this.client.getOrderBook(tokenId);
      const bestAsk = parseFloat(book?.asks?.[0]?.price || 0.55);
      const bestBid = parseFloat(book?.bids?.[0]?.price || 0.45);

      // Step 3 — Slippage-protected price (round to tickSize)
      let price;
      const clobSide = side === 'BUY' ? this.Side.BUY : this.Side.SELL;
      if (side === 'BUY') {
        price = Math.min(bestAsk + 0.02, 0.97);
      } else {
        price = Math.max(bestBid - 0.02, 0.03);
      }
      const ticks = Math.round(parseFloat(tickSize) || 0.01);
      price = Math.round(price / ticks) * ticks;

      logger.info(`[PolymarketClient.${fn}] Placing GTC order`, {
        ...ctx, price, tickSize, negRisk
      });

      // Step 4 — Place GTC limit order (stays open until filled)
      const resp = await this.client.createAndPostMarketOrder(
        { tokenID: tokenId, side: clobSide, amount: usdcAmount, price },
        { tickSize, negRisk },
        this.OrderType.GTC
      );

      logger.info(`[PolymarketClient.${fn}] Order placed`, {
        ...ctx, orderId: resp?.orderID || resp?.order_id, status: resp?.status
      });
      logger.info(`[PolymarketClient.${fn}] Order response`, {
        response: JSON.stringify(resp).slice(0, 300)
      });
      return resp;
    } catch (err) {
      const status = err.response?.status;
      if (status === 400) {
        logger.error(`[PolymarketClient.${fn}] Bad request — CLOB rejected order`, {
          ...ctx, detail: err.response?.data, hint: 'Check tokenId, price, and usdcAmount'
        });
      } else if (status === 401 || status === 403) {
        logger.error(`[PolymarketClient.${fn}] Auth failure`, {
          ...ctx, hint: 'Verify POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS'
        });
      } else if (status === 429) {
        logger.error(`[PolymarketClient.${fn}] Rate limited`, {
          ...ctx, retryAfter: err.response?.headers?.['retry-after']
        });
      } else {
        apiError(fn, err, ctx);
      }
      throw err;
    }
  }

  async cancelOrder(orderId) {
    const fn = 'cancelOrder';
    if (this.readOnly) {
      logger.info(`[PolymarketClient.${fn}] READ-ONLY: simulated cancel`, { orderId });
      return { simulated: true };
    }
    try {
      const resp = await this.client.cancelOrder({ orderID: orderId });
      logger.info(`[PolymarketClient.${fn}] Cancelled`, { orderId });
      return resp;
    } catch (err) {
      apiError(fn, err, { orderId });
      throw err;
    }
  }

  async getPositions() {
    const fn = 'getPositions';
    if (!this.client) return [];
    try {
      return await this.client.getPositions() || [];
    } catch (err) {
      apiError(fn, err);
      return [];
    }
  }

  async getOrderbook(tokenId) {
    const fn = 'getOrderbook';
    try {
      return await this.client.getOrderBook(tokenId);
    } catch (err) {
      apiError(fn, err, { tokenId });
      return null;
    }
  }
}

module.exports = new PolymarketClient();
