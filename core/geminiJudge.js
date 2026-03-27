'use strict';
// @google/genai is ESM-only — loaded via dynamic import in init()

// Helper to extract text from Gemini response (SDK returns nested structure)
function extractText(response) {
  return response?.candidates?.[0]?.content?.parts?.[0]?.text ||
         response?.text ||
         '';
}

// ═══════════════════════════════════════
// COST MODEL — GEMINI-FIRST PIPELINE
// ═══════════════════════════════════════
// Gemini 2.5 Flash: $0.30 input / $2.50 output per 1M tokens
// Per analysis call: ~300 tokens in + 150 out = $0.000465
//
// Sonnet 4.6: $3 input / $15 output per 1M tokens
// Per analysis call: ~300 tokens in + 150 out = $0.00315
//
// NEW PIPELINE (Gemini-first):
//   Layer 1: Haiku Scout     — cheap filter (~$0.001/market)
//   Layer 2: Gemini Judge    — PRIMARY analyst (~$0.0005/market)
//   Layer 3: Sonnet Arbiter  — ONLY edge ≥10%, conf ≥70%, liq ≥$200k (~$0.015/market)
//
// Sonnet now runs only on ~5% of markets (exceptional trades only)
//
// Daily cost estimate (6 agents, optimized intervals):
//   Haiku scouts:   ~100 calls × $0.001  = $0.10
//   Gemini judges:  ~100 calls × $0.0005 = $0.05
//   Sonnet arbiter: ~5 calls   × $0.015  = $0.075
//   Total: ~$0.225/day = ~$6.75/month (92% reduction from $45/month)
// ═══════════════════════════════════════

const logger = require('./logger');
const aiQueue = require('./aiQueue');

const JUDGE_SYSTEM = `You are a professional prediction market quantitative analyst.
Your edge comes from:
1. Base rate reasoning — what historically happens in situations like this
2. Reference class forecasting — compare to similar past events
3. Bayesian updating — start from base rate, update for current evidence
4. Market bias detection — Polymarket tends to overprice dramatic events

KNOWN POLYMARKET BIASES (exploit these):
- War/invasion markets: overpriced by 2-3x (people fear drama)
- Ceasefire markets: underpriced (people ignore diplomacy)
- Fed rate hike markets: overpriced when hiking cycle is over
- Sports underdog markets: slightly overpriced (casual bettor bias)
- Long-shot political events: overpriced 2-4x (availability heuristic)

CALIBRATION TARGETS:
- Your true_probability should be calibrated (if you say 20%, it should happen ~20% of the time)
- Edge should reflect genuine information advantage, not noise
- Confidence = how sure you are about your probability estimate

When you see a market at 50-70% for a dramatic geopolitical event
(war, invasion, regime change) — this is almost always overpriced.
True probability is typically 20-40% lower.

Output ONLY JSON — no markdown, no explanation outside JSON:
{"trade":"YES"|"NO"|"SKIP","true_probability":N,"confidence":N,"edge":N,"risk_level":"LOW"|"MEDIUM"|"HIGH","time_sensitivity":"LOW"|"MEDIUM"|"HIGH","reason":"under 10 words","key_factor":"main signal","warning":"main risk"}`;

class GeminiJudge {
  constructor() {
    this.apiKey    = process.env.GEMINI_API_KEY || null;
    this.modelName = process.env.GEMINI_MODEL   || 'gemini-2.5-flash';
    this.genAI     = null;
    this.enabled   = false;
    this._failCount  = 0;
    this._failThreshold = 10;  // Increase from implicit 3 — less aggressive
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

  async analyze(market, context, sharpSignals = []) {
    if (!this.isAvailable()) {
      return null; // fall through to Sonnet
    }

    this.callCount++;

    const headlines = (context?.headlines || []).slice(0, 3).join(' | ');
    const btc = context?.btcPrice?.price
      ? `BTC: $${context.btcPrice.price.toLocaleString()}`
      : '';
    const sharpBlock = sharpSignals.length > 0
      ? `Sharp traders: ${sharpSignals.slice(0, 2).join(' | ')}`
      : '';

    const prompt = `You are an expert quantitative prediction market analyst.

Market: "${market.question}"
Category: ${market.category} | Closes: ${market.endDate?.slice(0, 10) || '?'}
Current probability: ${market.marketProb}% | Volume 24h: $${((market.volume24hr || 0) / 1000).toFixed(0)}k | Liquidity: $${((market.liquidity || 0) / 1000).toFixed(0)}k

News context: ${headlines || 'none'}
${btc}
${sharpBlock}

Analyze for statistical mispricing. Be decisive — commit to YES or NO when edge exists.

Respond ONLY with this JSON (no markdown, no text outside JSON):
{"trade":"YES"|"NO"|"SKIP","true_probability":N,"confidence":N,"edge":N,"risk_level":"LOW"|"MEDIUM"|"HIGH","time_sensitivity":"LOW"|"MEDIUM"|"HIGH","reason":"under 10 words","key_factor":"main signal","warning":"main risk"}`;

    // Wrap the actual Gemini call in the global queue
    return aiQueue.enqueueGemini(async () => {
      try {
        const response = await this.genAI.models.generateContent({
          model:    this.modelName,
          contents: prompt,
          config: {
            temperature:     0.15,
            maxOutputTokens: 300
          }
        });

        const raw    = extractText(response);
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
        logger.warn('GeminiJudge failed', {
          error:     e.message,
          status:    e.status,
          code:      e.code,
          failCount: this._failCount
        });

        // Rate limit (429) — short cooldown
        if (e.status === 429 || e.message?.includes('429') || e.message?.includes('quota') || e.message?.includes('rate limit')) {
          this._disabled = true;
          setTimeout(() => { this._disabled = false; this._failCount = 0; }, 60 * 1000);
          logger.warn('GeminiJudge: rate limited — 1 min cooldown');
        } else if (this._failCount >= this._failThreshold) {
          // Repeated other errors — brief cooldown
          this._disabled = true;
          setTimeout(() => { this._disabled = false; this._failCount = 0; }, 2 * 60 * 1000);
          logger.warn(`GeminiJudge: ${this._failThreshold} failures — 2 min cooldown`);
        }

        return null; // fall through to Sonnet
      }
    }, 'normal');
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
