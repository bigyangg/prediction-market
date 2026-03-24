'use strict';
// @google/genai is ESM-only — loaded via dynamic import in init()

// ═══════════════════════════════════════
// COST MODEL
// ═══════════════════════════════════════
// Gemini 2.5 Flash: $0.30 input / $2.50 output per 1M tokens
// Per analysis call: ~300 tokens in + 150 out = $0.000465
//
// Sonnet 4.6: $3 input / $15 output per 1M tokens
// Per analysis call: ~300 tokens in + 150 out = $0.00315
//
// Sonnet only runs when:
//   - Gemini edge >= 6% AND confidence >= 60% AND liquidity >= $500k
//   - Estimated: 5-10% of markets (the very best ones)
//
// Daily cost estimate (6 agents, optimized intervals):
//   Haiku scouts:   ~200 calls × $0.001  = $0.20
//   Gemini judges:  ~100 calls × $0.0005 = $0.05
//   Sonnet arbiter: ~10 calls  × $0.003  = $0.03
//   Total: ~$0.28/day vs $5+ before (94% reduction)
// ═══════════════════════════════════════

const logger = require('./logger');

const JUDGE_SYSTEM = `You are a quantitative prediction market trading engine.
Analyze markets for statistical mispricing between market probability and true probability.

Be DECISIVE. Output ONLY this exact JSON (no markdown, no text):
{"trade":"YES"|"NO"|"SKIP","true_probability":N,"confidence":N,"edge":N,"risk_level":"LOW"|"MEDIUM"|"HIGH","time_sensitivity":"LOW"|"MEDIUM"|"HIGH","reason":"under 10 words","key_factor":"main signal","warning":"main risk"}

RULES:
- YES if true_prob > market_prob by 4%+ AND confidence >= 55%
- NO if true_prob < market_prob by 4%+ AND confidence >= 55%
- SKIP only if genuinely no signal
- LOW risk: clear signal, good liquidity
- MEDIUM risk: some uncertainty
- HIGH risk: thin liquidity or speculative — need 10%+ edge
- Do NOT default to SKIP — commit to a direction when signal exists`;

class GeminiJudge {
  constructor() {
    this.apiKey    = process.env.GEMINI_API_KEY || null;
    this.modelName = process.env.GEMINI_MODEL   || 'gemini-2.5-flash';
    this.genAI     = null;
    this.enabled   = false;
    this._failCount  = 0;
    this._disabled   = false;
    this.callCount   = 0;
    this.skipCount   = 0;
    this.tradeCount  = 0;
  }

  async init() {
    if (!this.apiKey || this.apiKey === 'your_gemini_api_key_here') {
      logger.warn('GeminiJudge: no API key — disabled');
      return;
    }
    try {
      const { GoogleGenAI } = await import('@google/genai');
      this.genAI   = new GoogleGenAI({ apiKey: this.apiKey });
      this.enabled = true;
      logger.info('GeminiJudge: ACTIVE', { model: this.modelName });
    } catch (e) {
      logger.warn('GeminiJudge init failed', { error: e.message });
    }
  }

  isAvailable() {
    return this.enabled && !this._disabled;
  }

  _extractJSON(text) {
    const clean = text.replace(/```json|```/g, '').trim();
    try { return JSON.parse(clean); } catch (_) { /* continue */ }
    const s = clean.indexOf('{');
    const e = clean.lastIndexOf('}');
    if (s !== -1 && e > s) {
      try { return JSON.parse(clean.slice(s, e + 1)); } catch (_) { /* continue */ }
    }
    throw new Error('No JSON in: ' + clean.slice(0, 100));
  }

  async analyze(market, context) {
    if (!this.isAvailable()) {
      return null; // fall through to Sonnet
    }

    this.callCount++;

    const headlines = (context?.headlines || []).slice(0, 3).join(' | ');
    const btc = context?.btcPrice?.price
      ? `BTC $${context.btcPrice.price.toLocaleString()}`
      : '';

    const prompt = `${JUDGE_SYSTEM}

Market: "${market.question}"
Category: ${market.category} | Closes: ${market.endDate?.slice(0, 10) || '?'}
Probability: ${market.marketProb}% | Vol24h: $${((market.volume24hr || 0) / 1000).toFixed(0)}k | Liq: $${((market.liquidity || 0) / 1000).toFixed(0)}k
News: ${headlines || 'none'} ${btc}

Analyze and respond with JSON only.`;

    try {
      const response = await this.genAI.models.generateContent({
        model:    this.modelName,
        contents: prompt,
        config: {
          tools:           [{ googleSearch: {} }], // live web search
          temperature:     0.1,
          maxOutputTokens: 250
        }
      });

      const raw    = response.text;
      const parsed = this._extractJSON(raw);
      parsed.market_probability = market.marketProb;

      this._failCount = 0;

      if (parsed.trade !== 'SKIP') this.tradeCount++;
      else this.skipCount++;

      logger.info('GeminiJudge decision', {
        trade:      parsed.trade,
        edge:       parsed.edge,
        confidence: parsed.confidence,
        market:     market.question?.slice(0, 50)
      });

      return parsed;

    } catch (e) {
      this._failCount++;
      if (this._failCount >= 3) {
        this._disabled = true;
        setTimeout(() => {
          this._disabled  = false;
          this._failCount = 0;
        }, 5 * 60 * 1000);
        logger.warn('GeminiJudge: 3 failures — cooling 5 min');
      }
      logger.warn('GeminiJudge failed', { error: e.message });
      return null; // fall through to Sonnet
    }
  }

  getStats() {
    return {
      enabled:   this.enabled,
      available: this.isAvailable(),
      model:     this.modelName,
      calls:     this.callCount,
      trades:    this.tradeCount,
      skips:     this.skipCount,
      skipRate:  this.callCount
        ? parseFloat((this.skipCount / this.callCount * 100).toFixed(1))
        : 0
    };
  }
}

module.exports = new GeminiJudge();
