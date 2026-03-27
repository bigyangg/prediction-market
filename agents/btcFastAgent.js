'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// BTCFastAgent — Professional multi-signal BTC momentum trader
// ═══════════════════════════════════════════════════════════════════════════
// Scans every 60s. Combines 7 signals: short momentum, long momentum,
// acceleration, consistency, hour trend, volatility filter, range position.
// Kelly-inspired staking with loss streak reduction.
// ═══════════════════════════════════════════════════════════════════════════

const logger = require('../core/logger');
const stateStore = require('../core/stateStore');
const riskManager = require('../core/riskManager');
const polymarketClient = require('../core/polymarketClient');
const supervisor = require('../core/supervisor');
const geminiJudge = require('../core/geminiJudge');
const axios = require('axios');

class BTCFastAgent {
  constructor() {
    this.name = 'BTCFastAgent';
    this.category = 'crypto';
    this.scanInterval = 60000;
    this.active = false;
    this.scansCompleted = 0;
    this.intervalId = null;

    // Price history — stores last 10 readings (~10 minutes)
    this.priceHistory = [];

    // Trade management
    this.lastTradeTime = 0;
    this.minTimeBetweenTrades = 5 * 60 * 1000;  // 5 min cooldown
    this.tradesWon = 0;
    this.tradesLost = 0;
    this.consecutiveLosses = 0;
    this.geminiChecksToday = 0;
    this.maxGeminiChecksPerDay = 10;
  }

  // ── Price Data ─────────────────────────────────────────────────────────────

  async getBTCPrice() {
    // Source 1: CryptoCompare (full OHLCV data)
    try {
      const res = await axios.get(
        'https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC&tsyms=USD',
        { timeout: 5000 }
      );
      const raw = res.data.RAW?.BTC?.USD;
      if (raw?.PRICE) return {
        price: raw.PRICE,
        high24h: raw.HIGH24HOUR,
        low24h: raw.LOW24HOUR,
        change1h: raw.CHANGEPCTHOUR,
        change24h: raw.CHANGEPCT24HOUR,
        volume24h: raw.VOLUME24HOURTO,
        source: 'cryptocompare'
      };
    } catch (e) {
      logger.warn('BTCFastAgent: CryptoCompare failed', { error: e.message });
    }

    // Source 2: Kraken (professional exchange, never blocked)
    try {
      const res = await axios.get(
        'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
        { timeout: 5000 }
      );
      const t = res.data.result?.XXBTZUSD;
      if (t) {
        const price = parseFloat(t.c[0]);
        const open = parseFloat(t.o);
        return {
          price,
          high24h: parseFloat(t.h[1]),
          low24h: parseFloat(t.l[1]),
          volume24h: parseFloat(t.v[1]),
          change24h: ((price - open) / open * 100),
          ask: parseFloat(t.a[0]),
          bid: parseFloat(t.b[0]),
          spread: parseFloat(t.a[0]) - parseFloat(t.b[0]),
          source: 'kraken'
        };
      }
    } catch (e) {
      logger.warn('BTCFastAgent: Kraken failed', { error: e.message });
    }

    // Source 3: CryptoCompare simple fallback
    try {
      const res = await axios.get(
        'https://min-api.cryptocompare.com/data/price?fsym=BTC&tsyms=USD',
        { timeout: 4000 }
      );
      if (res.data?.USD) return { price: res.data.USD, source: 'cc-simple' };
    } catch (e) {
      logger.warn('BTCFastAgent: CC-simple failed', { error: e.message });
    }

    return null;
  }

  // Get Kraken order book depth — buying vs selling pressure
  async getOrderBookSignal() {
    try {
      const res = await axios.get(
        'https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=10',
        { timeout: 4000 }
      );
      const book = res.data.result?.XXBTZUSD;
      if (!book) return null;

      // Sum top 10 bids vs asks volume
      const bidVolume = book.bids.slice(0, 10)
        .reduce((sum, b) => sum + parseFloat(b[1]), 0);
      const askVolume = book.asks.slice(0, 10)
        .reduce((sum, a) => sum + parseFloat(a[1]), 0);

      const ratio = bidVolume / (bidVolume + askVolume);
      // ratio > 0.6 = more buyers = bullish
      // ratio < 0.4 = more sellers = bearish

      return {
        bidVolume: bidVolume.toFixed(2),
        askVolume: askVolume.toFixed(2),
        ratio: ratio.toFixed(3),
        signal: ratio > 0.6 ? 'BULLISH' : ratio < 0.4 ? 'BEARISH' : 'NEUTRAL'
      };
    } catch (_) {
      return null;
    }
  }

  // ── Technical Analysis ─────────────────────────────────────────────────────

  analyze(currentPrice, btcData, orderBook = null) {
    if (this.priceHistory.length < 3) return null;

    const prices = this.priceHistory.map(p => p.price);
    const now = currentPrice;

    // 1. SHORT MOMENTUM (last 3 readings = ~3 min)
    const last3 = prices.slice(-3);
    const shortChange = ((now - last3[0]) / last3[0] * 100);

    // 2. MEDIUM MOMENTUM (all readings = up to ~10 min)
    const longChange = ((now - prices[0]) / prices[0] * 100);

    // 3. ACCELERATION — is momentum speeding up or slowing?
    const midPoint = prices[Math.floor(prices.length / 2)];
    const firstHalfChange  = ((midPoint - prices[0]) / prices[0] * 100);
    const secondHalfChange = ((now - midPoint) / midPoint * 100);
    const accelerating = Math.abs(secondHalfChange) > Math.abs(firstHalfChange);

    // 4. CONSISTENCY — consecutive moves in same direction
    const direction = now > prices[prices.length - 2] ? 1 : -1;
    let consecutive = 0;
    for (let i = prices.length - 1; i > 0; i--) {
      const move = prices[i] > prices[i - 1] ? 1 : -1;
      if (move === direction) consecutive++;
      else break;
    }

    // 5. VOLATILITY — average absolute move per interval
    const moves = [];
    for (let i = 1; i < prices.length; i++) {
      moves.push(Math.abs((prices[i] - prices[i - 1]) / prices[i - 1] * 100));
    }
    const avgMove = moves.length > 0
      ? moves.reduce((a, b) => a + b, 0) / moves.length
      : 0.03;
    const highVolatility = avgMove > 0.05;

    // 6. POSITION IN 24H RANGE
    let rangePosition = 50;
    if (btcData?.high24h && btcData?.low24h) {
      const range = btcData.high24h - btcData.low24h;
      if (range > 0) rangePosition = ((now - btcData.low24h) / range * 100);
    }

    // 7. 1-HOUR TREND from exchange data
    const hourTrend = btcData?.change1h || 0;

    // Dynamic thresholds based on current volatility
    const strongThreshold = Math.max(0.03, avgMove * 1.5);
    const weakThreshold = Math.max(0.01, avgMove * 0.5);

    return {
      shortChange,
      longChange,
      accelerating,
      consecutive,
      highVolatility,
      rangePosition,
      hourTrend,
      direction,
      avgMove,
      strongThreshold,
      weakThreshold,
      orderBook
    };
  }

  // ── Signal Generation ──────────────────────────────────────────────────────

  generateSignal(ta, marketProb) {
    if (!ta) return null;

    const { shortChange, accelerating, consecutive, highVolatility,
            rangePosition, hourTrend, avgMove, strongThreshold,
            weakThreshold, orderBook } = ta;

    let bullishPoints = 0;
    let bearishPoints = 0;
    const reasons = [];

    // SHORT MOMENTUM — use FIXED thresholds (dynamic was too strict)
    // 0.02% in 3 min = weak signal, 0.05% = strong signal
    if (shortChange > 0.05) {
      bullishPoints += 3;
      reasons.push('strong momentum');
    } else if (shortChange > 0.02) {
      bullishPoints += 2;
      reasons.push('momentum up');
    } else if (shortChange < -0.05) {
      bearishPoints += 3;
      reasons.push('strong sell');
    } else if (shortChange < -0.02) {
      bearishPoints += 2;
      reasons.push('momentum down');
    }

    // CONSISTENCY bonus (lowered from 3 to 2 consecutive)
    if (consecutive >= 2 && ta.direction ===  1) { bullishPoints += 2; reasons.push(`${consecutive} up`); }
    if (consecutive >= 2 && ta.direction === -1) { bearishPoints += 2; reasons.push(`${consecutive} down`); }

    // ACCELERATION bonus
    if (accelerating && shortChange >  0) { bullishPoints += 1; reasons.push('accelerating'); }
    if (accelerating && shortChange <  0) { bearishPoints += 1; reasons.push('accelerating'); }

    // 1-HOUR TREND alignment (lowered from 0.5 to 0.3)
    if (hourTrend >  0.3 && shortChange >  0) { bullishPoints += 1; reasons.push('1h confirms'); }
    if (hourTrend < -0.3 && shortChange <  0) { bearishPoints += 1; reasons.push('1h confirms'); }

    // MEAN REVERSION — fade extremes (widened from 90/10 to 85/15)
    if (rangePosition > 85) { bearishPoints += 1; reasons.push('near 24h high'); }
    if (rangePosition < 15) { bullishPoints += 1; reasons.push('near 24h low'); }

    // ORDER BOOK PRESSURE (lowered thresholds from 0.6/0.4 to 0.55/0.45)
    if (orderBook?.signal === 'BULLISH' || parseFloat(orderBook?.ratio) > 0.55) {
      bullishPoints += 2;
      reasons.push(`book ${orderBook?.ratio || '?'}`);
    }
    if (orderBook?.signal === 'BEARISH' || parseFloat(orderBook?.ratio) < 0.45) {
      bearishPoints += 2;
      reasons.push(`book ${orderBook?.ratio || '?'}`);
    }

    // Dynamic volatility skip — only skip if move is 4x average (was 3x)
    if (highVolatility && Math.abs(shortChange) > avgMove * 4) {
      return { 
        signal: 'SKIP', 
        reason: 'extreme volatility spike', 
        confidence: 0,
        score: 0,
        bullishPoints,
        bearishPoints
      };
    }

    // No clear direction — lowered from 2 to 1 point difference
    if (Math.abs(bullishPoints - bearishPoints) < 1) {
      return { 
        signal: 'SKIP', 
        reason: 'mixed signals', 
        confidence: 0,
        score: 50,
        bullishPoints,
        bearishPoints
      };
    }

    const dominantPoints = Math.max(bullishPoints, bearishPoints);
    const totalPoints    = bullishPoints + bearishPoints;
    const rawConfidence  = Math.min(85, 50 + (dominantPoints / totalPoints * 40));

    if (bullishPoints > bearishPoints) {
      const trueProbUp = Math.min(85, marketProb + (bullishPoints * 4));
      const edge = trueProbUp - marketProb;
      if (edge < 5) return { signal: 'SKIP', reason: 'insufficient edge', confidence: 0 };
      
      const score = Math.min(100, 50 + (dominantPoints / Math.max(totalPoints, 1) * 50));
      
      return {
        signal:          'YES',
        trueProbability: trueProbUp,
        edge,
        confidence:      rawConfidence,
        reasons:         reasons.slice(0, 3),
        scoreLabel:      `${bullishPoints}bull vs ${bearishPoints}bear`,
        score,
        bullishPoints,
        bearishPoints
      };
    } else {
      const trueProbUp = Math.max(15, marketProb - (bearishPoints * 4));
      const edge = marketProb - trueProbUp;
      if (edge < 5) return { signal: 'SKIP', reason: 'insufficient edge', confidence: 0 };
      
      const score = Math.min(100, 50 + (dominantPoints / Math.max(totalPoints, 1) * 50));
      
      return {
        signal:          'NO',
        trueProbability: trueProbUp,
        edge,
        confidence:      rawConfidence,
        reasons:         reasons.slice(0, 3),
        scoreLabel:      `${bearishPoints}bear vs ${bullishPoints}bull`,
        score,
        bullishPoints,
        bearishPoints
      };
    }
  }

  // ── Market Finder ──────────────────────────────────────────────────────────

  async findBTCMarket() {
    try {
      // Try cache first
      let markets = await polymarketClient.getActiveMarkets('crypto');
      logger.info('BTCFastAgent: findBTCMarket', { 
        totalMarkets: markets?.length || 0 
      });
      
      // Filter for BTC markets
      let btc = this.filterBTCMarkets(markets);
      
      // Check if any have valid token IDs
      let validMarket = btc.find(m => m.clobTokenIds?.length > 0 || m.tokenIds?.length > 0);
      
      // If cache doesn't have token IDs, fetch fresh from Gamma API
      if (!validMarket && btc.length > 0) {
        logger.info('BTCFastAgent: cache missing token IDs, fetching from Gamma API');
        try {
          const axios = require('axios');
          const res = await axios.get('https://gamma-api.polymarket.com/markets', {
            params: { active: true, closed: false, limit: 50, order: 'volume24hr', ascending: false },
            timeout: 10000
          });
          
          const fresh = Array.isArray(res.data) ? res.data : [];
          const freshBtc = fresh.filter(m => {
            const q = (m.question || '').toLowerCase();
            return (q.includes('btc') || q.includes('bitcoin'));
          });
          
          if (freshBtc.length > 0) {
            // Parse clobTokenIds from JSON string
            const market = freshBtc[0];
            let tokenIds = market.clobTokenIds;
            if (typeof tokenIds === 'string') {
              try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = []; }
            }
            
            logger.info('BTCFastAgent: fresh market from Gamma', {
              question: market.question?.slice(0, 80),
              tokenIds: tokenIds?.slice(0, 2),
              hasTokens: tokenIds?.length > 0
            });
            
            if (tokenIds?.length > 0) {
              return {
                ...market,
                clobTokenIds: tokenIds,
                tokenIds: tokenIds,
                marketProb: Math.round(parseFloat(market.outcomePrices?.[0] || market.bestAsk || 0.5) * 100)
              };
            }
          }
        } catch (e) {
          logger.warn('BTCFastAgent: Gamma API fetch failed', { error: e.message });
        }
      }
      
      if (validMarket) {
        // Normalize tokenIds field
        validMarket.clobTokenIds = validMarket.clobTokenIds || validMarket.tokenIds || [];
        return validMarket;
      }
      
      logger.warn('BTCFastAgent: no BTC market with valid token IDs');
      return null;
    } catch (e) {
      logger.warn('BTCFastAgent: findBTCMarket failed', { error: e.message });
      return null;
    }
  }
  
  filterBTCMarkets(markets) {
    if (!markets?.length) return [];
    
    // First try: BTC short-term markets (5-min, up/down)
    let btc = markets.filter(m => {
      const q = (m.question || '').toLowerCase();
      return (q.includes('btc') || q.includes('bitcoin')) &&
             (q.includes('5') || q.includes('minute') || q.includes('up or down') || q.includes('price'));
    }).sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
    
    // Fallback: any BTC market
    if (btc.length === 0) {
      btc = markets.filter(m => {
        const q = (m.question || '').toLowerCase();
        return q.includes('btc') || q.includes('bitcoin');
      }).sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
    }
    
    return btc;
  }

  // ── Stake Sizing — Kelly-inspired with loss streak reduction ──────────────

  calculateStake(signal) {
    const edgeFraction       = signal.edge / 100;
    const confidenceFraction = signal.confidence / 100;
    const kellyStake         = edgeFraction * confidenceFraction * 20;  // max $20 base

    let lossMultiplier = 1;
    if      (this.consecutiveLosses >= 3) lossMultiplier = 0.25;
    else if (this.consecutiveLosses >= 2) lossMultiplier = 0.5;
    else if (this.consecutiveLosses >= 1) lossMultiplier = 0.75;

    // Apply supervisor risk adjustment
    const supervisorMultiplier = supervisor.getRiskMultiplier();
    
    const stake = Math.min(5, Math.max(1, kellyStake * lossMultiplier * supervisorMultiplier));
    return parseFloat(stake.toFixed(2));
  }

  // ── Main Scan ──────────────────────────────────────────────────────────────

  async scan() {
    if (!this.active) return;
    this.scansCompleted++;

    logger.info('BTCFastAgent: scan starting', {
      scan: this.scansCompleted,
      engineRunning: stateStore.engineRunning,
      engineHalted: stateStore.engineHalted,
      supervisorActive: supervisor.isSystemActive()
    });

    try {
      if (stateStore.engineHalted) {
        logger.debug('BTCFastAgent: engine halted by risk manager');
        return;
      }
      // Note: engineRunning check removed — BTCFastAgent manages
      // its own active state via this.active

      // Check supervisor status
      if (!supervisor.isSystemActive()) {
        logger.info('BTCFastAgent: paused by supervisor');
        return;
      }

      // 1. Get live BTC price + order book in parallel
      const [btcData, orderBook] = await Promise.all([
        this.getBTCPrice(),
        this.getOrderBookSignal()
      ]);

      if (!btcData?.price) {
        logger.warn('BTCFastAgent: no price data — all sources failed');
        return;
      }

      // 2. Update price history (rolling 10)
      this.priceHistory.push({ price: btcData.price, time: Date.now() });
      if (this.priceHistory.length > 10) this.priceHistory.shift();

      // 3. Run technical analysis with order book
      const ta = this.analyze(btcData.price, btcData, orderBook);
      const histLen = this.priceHistory.length;

      logger.info(`BTCFastAgent scan price=$${btcData.price.toLocaleString()} source=${btcData.source} history=${histLen}/10 momentum=${ta ? (ta.shortChange >= 0 ? '+' : '') + ta.shortChange.toFixed(4) + '%' : 'building'} orderBook=${orderBook?.signal || 'N/A'}`);

      if (histLen < 3) return;  // need minimum history

      // 4. Cooldown check
      const cooldownRemaining = this.minTimeBetweenTrades - (Date.now() - this.lastTradeTime);
      if (cooldownRemaining > 0) {
        logger.debug('BTCFastAgent: cooldown', { remaining: Math.ceil(cooldownRemaining / 1000) + 's' });
        return;
      }

      // 5. Find live BTC market
      const market = await this.findBTCMarket();
      if (!market) {
        logger.debug('BTCFastAgent: no BTC market found');
        return;
      }

      // 6. Generate multi-signal decision
      logger.info('BTCFastAgent: calling generateSignal', { 
        ta: !!ta, 
        marketProb: market.marketProb,
        taShortChange: ta?.shortChange,
        taBull: ta?.bullishPoints,
        taBear: ta?.bearishPoints
      });
      
      const signal = this.generateSignal(ta, market.marketProb || 50);

      logger.info(`BTCFastAgent signal score=${signal?.score || 0} direction=${signal?.signal || 'none'} bull=${signal?.bullishPoints || 0} bear=${signal?.bearishPoints || 0} reason=${signal?.reasons?.[0] || signal?.reason || 'none'}`);

      if (!signal || signal.signal === 'SKIP') {
        logger.info('BTCFastAgent: no trade', {
          reason:     signal?.reason || 'no signal',
          marketProb: (market.marketProb || 50) + '%',
          bullishPoints: signal?.bullishPoints || 0,
          bearishPoints: signal?.bearishPoints || 0
        });
        return;
      }

      logger.info('BTCFastAgent SIGNAL DETECTED', {
        direction: signal.signal,
        score: signal.score + '/100',
        edge: signal.edge.toFixed(1) + '%',
        confidence: signal.confidence.toFixed(0) + '%',
        bullishPoints: signal.bullishPoints,
        bearishPoints: signal.bearishPoints,
        reasons: signal.reasons,
        orderBook: orderBook?.signal || 'N/A',
        dynamicThreshold: ta.strongThreshold?.toFixed(4) + '%',
        marketProb: (market.marketProb || 50) + '%',
        trueProb: signal.trueProbability.toFixed(0) + '%'
      });

      // ═══════════════════════════════════════════════════════════════════
      // SCORE-BASED LLM ROUTING (Supervisor Pattern)
      // ═══════════════════════════════════════════════════════════════════
      // score >= 70: execute directly (no LLM)
      // score 50-69: optional Gemini check (max 10/day)
      // score < 50: skip
      // ═══════════════════════════════════════════════════════════════════
      
      if (signal.score < 50) {
        logger.info('BTCFastAgent: low confidence — skipping', { 
          score: signal.score 
        });
        return;
      }

      if (signal.score >= 70) {
        logger.info('BTCFastAgent: high confidence — direct execution', {
          score: signal.score
        });
        // proceed to execute
      } else if (signal.score >= 50 && geminiJudge.isAvailable() && 
                 this.geminiChecksToday < this.maxGeminiChecksPerDay) {
        logger.info('BTCFastAgent: medium confidence — requesting Gemini check', {
          score: signal.score
        });
        const geminiOk = await this.geminiCheck(signal, market, btcData);
        if (!geminiOk) {
          logger.info('BTCFastAgent: Gemini rejected trade');
          return;
        }
        this.geminiChecksToday++;
      }

      // 7. Calculate Kelly stake
      const stake = this.calculateStake(signal);

      // 8. Final risk manager approval
      const approval = riskManager.approve({
        trade:              signal.signal,
        edge:               signal.edge,
        confidence:         signal.confidence,
        true_probability:   signal.trueProbability,
        market_probability: market.marketProb || 50,
        risk_level:         signal.confidence > 70 ? 'LOW' : 'MEDIUM'
      }, riskManager.openTrades?.size || 0, {
        minEdge:          5,
        minConfidence:    55,
        stakeMultiplier:  0.3
      });

      if (!approval.approved) {
        logger.info('BTCFastAgent: risk rejected', { reason: approval.reason });
        return;
      }

      // 9. Execute — get token ID for the side we want
      // YES = clobTokenIds[0], NO = clobTokenIds[1]
      const tokenIndex = signal.signal === 'YES' ? 0 : 1;
      const tokenId = market.clobTokenIds?.[tokenIndex] || market.tokenId;
      
      if (!tokenId) {
        logger.error('BTCFastAgent: no token ID for trade', { 
          market: market.question?.slice(0, 60),
          clobTokenIds: market.clobTokenIds,
          tokenId: market.tokenId
        });
        return;
      }
      
      logger.info('BTCFastAgent: placing order', { tokenId, side: signal.signal, stake });
      
      const result = await polymarketClient.placeOrder({
        tokenId,
        side:           signal.signal,
        usdcAmount:     stake,
        marketQuestion: market.question
      });

      if (result?.success !== false) {
        this.lastTradeTime = Date.now();

        logger.info('BTCFastAgent TRADE OPEN', {
          side:       signal.signal,
          stake:      '$' + stake,
          edge:       signal.edge.toFixed(1) + '%',
          confidence: signal.confidence.toFixed(0) + '%',
          score:      signal.score,
          btcPrice:   '$' + btcData.price.toLocaleString(),
          reasons:    signal.reasons.join(' | ')
        });

        stateStore.addNews({
          type:  'trade',
          agent: this.name,
          text:  `⚡ BTC ${signal.signal} | $${btcData.price.toLocaleString()} | ${signal.reasons[0]} | Edge: ${signal.edge.toFixed(0)}% | Score: ${signal.score}`
        });
      }

    } catch (e) {
      logger.error('BTCFastAgent error', { error: e.message });
    }

    // Update dashboard state
    const lastPrice = this.priceHistory[this.priceHistory.length - 1]?.price;
    const ta = lastPrice && this.priceHistory.length >= 3
      ? this.analyze(lastPrice, {})
      : null;

    stateStore.updateAgent(this.name, {
      category:     this.category,
      interval:     '60s',
      scans:        this.scansCompleted,
      active:       this.active,
      lastScan:     new Date().toISOString(),
      currentPrice: lastPrice,
      momentum:     ta ? (ta.shortChange > 0 ? '+' : '') + ta.shortChange.toFixed(3) + '%' : 'building',
      tradesWon:    this.tradesWon,
      tradesLost:   this.tradesLost,
      geminiChecksToday: this.geminiChecksToday
    });
  }

  // ── Gemini Quick Check (Medium Confidence Trades) ──────────────────────────

  async geminiCheck(signal, market, btcData) {
    try {
      const prompt = `BTC trade check. JSON only.
Signal: ${signal.signal} | Score: ${signal.score}/100
Market prob: ${market.marketProb}% | Est true: ${signal.trueProbability}%
Edge: ${signal.edge}% | Reason: ${signal.reasons[0]}
BTC price: $${btcData.price.toLocaleString()}

{"approve":true|false,"reason":"5 words max"}`;

      const r = await geminiJudge.genAI.models.generateContent({
        model: geminiJudge.modelName,
        contents: prompt,
        config: { temperature: 0, maxOutputTokens: 50 }
      });

      const text = r?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      const result = JSON.parse(text.slice(s, e + 1));
      
      logger.info('BTCFastAgent: Gemini check', {
        approved: result.approve,
        reason: result.reason,
        score: signal.score
      });
      
      return result.approve === true;

    } catch (e) {
      logger.debug('BTCFastAgent: Gemini check failed', { error: e.message });
      return true;  // default approve on error
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    if (this.active) {
      logger.warn('BTCFastAgent: start() called but already running');
      return;
    }
    this.active = true;
    logger.info('BTCFastAgent: started — multi-signal momentum strategy');
    stateStore.updateAgent(this.name, {
      category: this.category,
      interval: '60s',
      scans:    0,
      active:   true,
      status:   'active'
    });
    this.scan();
    this.intervalId = setInterval(() => this.scan(), this.scanInterval);
    
    // Reset daily Gemini check counter at midnight
    this._resetIntervalId = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() < 1) {
        this.geminiChecksToday = 0;
        logger.info('BTCFastAgent: daily Gemini check counter reset');
      }
    }, 60000);
  }

  stop() {
    this.active = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this._resetIntervalId) {
      clearInterval(this._resetIntervalId);
      this._resetIntervalId = null;
    }
    stateStore.updateAgent(this.name, { status: 'stopped', active: false });
    logger.info('BTCFastAgent: stopped');
  }
}

module.exports = new BTCFastAgent();
