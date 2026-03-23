'use strict';
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const logger = require('./logger');

// ── Validator prompt ──────────────────────────────────────────────────────────

const VALIDATOR_PROMPT = (market, decision) =>
  `You are an independent quantitative risk validator for prediction markets.
Another AI has proposed a trade. Use your web search capability to find
current real-world information about this market before deciding.

PROPOSED TRADE:
Market: "${market.question}"
Category: ${market.category}
Closes: ${market.endDate || 'unknown'}
Current market probability: ${decision.market_probability}%
24h volume: $${market.volume24hr?.toFixed(0) || '?'}
Liquidity: $${market.liquidity?.toFixed(0) || '?'}

Claude's decision:
- Trade: ${decision.trade} (${decision.trade === 'YES' ? 'BUY YES token' : 'BUY NO token'})
- True probability estimate: ${decision.true_probability}%
- Edge claimed: ${decision.edge > 0 ? '+' : ''}${decision.edge?.toFixed(1)}%
- Confidence: ${decision.confidence}%
- Risk: ${decision.risk_level}
- Reasoning: ${decision.reason}
- Key factor: ${decision.key_factor}
- Warning: ${decision.warning}

Search for current information about this topic.
Then validate: is this trade sound? Is the edge real?

Be a skeptic. VETO if:
- Your search contradicts Claude's reasoning
- The market is already efficiently priced given current news
- The edge is based on stale or wrong information
- Probability estimate is clearly off given what you found

CONFIRM if the trade logic holds up against current information.

Respond with ONLY this JSON (no markdown, no extra text):
{"verdict":"CONFIRM","confidence":0-100,"reason":"max 12 words","key_concern":"what you found","search_used":true}`;

// ── Validator class ───────────────────────────────────────────────────────────

class GeminiValidator {
  constructor() {
    this.apiKey    = process.env.GEMINI_API_KEY || null;
    this.modelName = process.env.GEMINI_MODEL   || 'gemini-2.5-flash';
    this.genAI     = null;
    this.enabled   = false;

    this._disabled     = false;
    this._failCount    = 0;
    this._failThreshold = 3;
    this._cooldownMs   = 10 * 60 * 1000;  // 10 min on rate limit
    this._failCooldownMs = 5 * 60 * 1000; //  5 min on repeated errors

    // Stats
    this.callCount       = 0;
    this.confirmCount    = 0;
    this.vetoCount       = 0;
    this.errorCount      = 0;
    this.searchUsedCount = 0;
  }

  init() {
    if (!this.apiKey || this.apiKey === 'your_gemini_api_key_here') {
      logger.info('GeminiValidator: no key — disabled');
      return;
    }
    try {
      this.genAI   = new GoogleGenAI({ apiKey: this.apiKey });
      this.enabled = true;
      logger.info('GeminiValidator: ACTIVE', {
        model:          this.modelName,
        searchGrounding: true
      });
    } catch (e) {
      logger.warn('GeminiValidator init failed', { error: e.message });
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
    throw new Error('No JSON found in: ' + clean.slice(0, 100));
  }

  _recordFailure(errMsg) {
    this._failCount++;
    if (errMsg.includes('API_KEY') || errMsg.includes('401') || errMsg.includes('403')) {
      this._disabled = true;
      logger.warn('GeminiValidator: key invalid/revoked — disabled permanently');
      return;
    }
    if (errMsg.includes('429') || errMsg.includes('QUOTA') || errMsg.includes('rate')) {
      this._disabled = true;
      setTimeout(() => { this._disabled = false; this._failCount = 0; }, this._cooldownMs);
      logger.warn('GeminiValidator: rate limited — cooling down 10 min');
      return;
    }
    if (this._failCount >= this._failThreshold) {
      this._disabled = true;
      setTimeout(() => { this._disabled = false; this._failCount = 0; }, this._failCooldownMs);
      logger.warn('GeminiValidator: 3 failures — cooling down 5 min');
    }
  }

  async validate(market, claudeDecision) {
    // Not configured or disabled — pass through, never block trades
    if (!this.isAvailable()) {
      return {
        verdict:      'CONFIRM',
        confidence:   0,
        reason:       'validator unavailable',
        key_concern:  'none',
        _skipped:     true
      };
    }

    this.callCount++;

    try {
      const response = await this.genAI.models.generateContent({
        model:    this.modelName,
        contents: VALIDATOR_PROMPT(market, claudeDecision),
        config: {
          tools:           [{ googleSearch: {} }],  // live web search
          temperature:     0.1,                     // low temp = consistent JSON
          maxOutputTokens: 300
        }
      });

      const raw    = response.text;
      const parsed = this._extractJSON(raw);

      // Track whether Gemini actually searched
      const groundingMeta = response.candidates?.[0]?.groundingMetadata;
      const queries       = groundingMeta?.webSearchQueries;
      if (parsed.search_used || (queries && queries.length > 0)) {
        this.searchUsedCount++;
        if (queries?.length) {
          logger.debug('GeminiValidator search queries', { queries });
        }
      }

      // Reset failure counter on success
      this._failCount = 0;
      if (parsed.verdict === 'CONFIRM') this.confirmCount++;
      else this.vetoCount++;

      logger.info('GeminiValidator', {
        verdict:    parsed.verdict,
        confidence: parsed.confidence,
        reason:     parsed.reason,
        concern:    parsed.key_concern,
        searchUsed: parsed.search_used,
        market:     market.question?.slice(0, 55)
      });

      return parsed;

    } catch (e) {
      this.errorCount++;
      this._recordFailure(e.message);
      logger.warn('GeminiValidator error — trade proceeds without validation', {
        error:  e.message,
        market: market.question?.slice(0, 40)
      });
      // Always CONFIRM on error — never block trades due to validator failure
      return {
        verdict:     'CONFIRM',
        confidence:  0,
        reason:      'validator error — proceeding',
        key_concern: e.message.slice(0, 50),
        _error:      true
      };
    }
  }

  getStats() {
    const total = this.confirmCount + this.vetoCount;
    return {
      enabled:    this.enabled,
      available:  this.isAvailable(),
      model:      this.modelName,
      calls:      this.callCount,
      confirms:   this.confirmCount,
      vetos:      this.vetoCount,
      vetoRate:   total ? parseFloat((this.vetoCount / total * 100).toFixed(1)) : 0,
      errors:     this.errorCount,
      searchUsed: this.searchUsedCount,
      searchRate: this.callCount ? parseFloat((this.searchUsedCount / this.callCount * 100).toFixed(1)) : 0,
      disabled:   this._disabled
    };
  }
}

module.exports = new GeminiValidator();
