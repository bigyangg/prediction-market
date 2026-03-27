'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET API REQUEST QUEUE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Dedicated rate limiter for Polymarket CLOB API calls.
 * Separate from aiQueue.js (which handles Gemini calls).
 * 
 * Polymarket rate limits (approximate):
 *   - REST API: ~120 requests/minute
 *   - WebSocket: no hard limit but don't spam
 * 
 * This queue:
 *   1. Limits concurrent requests to prevent overwhelming the API
 *   2. Enforces minimum delay between requests
 *   3. Provides back-pressure when queue is full
 *   4. Tracks stats for monitoring
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 */

const logger = require('./logger');
const { RequestQueue, retryWithBackoff, CircuitBreaker } = require('./resilience');

// ═══════════════════════════════════════════════════════════════════════════
// POLYMARKET API QUEUE
// ═══════════════════════════════════════════════════════════════════════════

class PolymarketQueue {
  constructor() {
    // Main request queue - conservative limits
    this.queue = new RequestQueue({
      name: 'polymarket',
      maxConcurrent: 3,          // max 3 concurrent API calls
      minDelayMs: 500,           // 500ms between calls = ~120/min max
      maxQueueSize: 50           // reject if queue gets too large
    });

    // Circuit breaker for API health
    this.circuitBreaker = new CircuitBreaker({
      name: 'polymarket-api',
      failureThreshold: 5,       // 5 failures triggers open
      recoveryTimeout: 30000     // wait 30s before testing recovery
    });

    // Separate queue for market data (can be more aggressive)
    this.marketDataQueue = new RequestQueue({
      name: 'polymarket-data',
      maxConcurrent: 5,
      minDelayMs: 200,
      maxQueueSize: 100
    });

    logger.info('[PolymarketQueue] Initialized with rate limiting');
  }

  /**
   * Execute an API call with rate limiting, retries, and circuit breaker
   * 
   * @param {Function} fn - Async function that makes the API call
   * @param {Object} options
   * @param {string} options.operationName - For logging
   * @param {boolean} options.isMarketData - Use market data queue (less strict)
   * @param {number} options.maxRetries - Override retry count
   * @param {string} options.priority - 'high' or 'normal'
   */
  async execute(fn, options = {}) {
    const {
      operationName = 'api-call',
      isMarketData = false,
      maxRetries = 3,
      priority = 'normal'
    } = options;

    const queue = isMarketData ? this.marketDataQueue : this.queue;

    // Wrap with retry logic
    const retriedFn = () => retryWithBackoff(fn, {
      maxRetries,
      baseDelay: 1000,
      maxDelay: 15000,
      operationName
    });

    // Wrap with circuit breaker
    const protectedFn = () => this.circuitBreaker.execute(retriedFn);

    // Add to queue
    return queue.enqueue(protectedFn, priority);
  }

  /**
   * Execute a trade-related API call (uses main queue with stricter limits)
   */
  async executeTrade(fn, options = {}) {
    return this.execute(fn, {
      ...options,
      isMarketData: false,
      priority: 'high'
    });
  }

  /**
   * Execute a market data API call (uses data queue, more lenient)
   */
  async executeMarketData(fn, options = {}) {
    return this.execute(fn, {
      ...options,
      isMarketData: true,
      priority: 'normal'
    });
  }

  getStats() {
    return {
      tradeQueue: this.queue.getStats(),
      marketDataQueue: this.marketDataQueue.getStats(),
      circuitBreaker: this.circuitBreaker.getState()
    };
  }
}

// Singleton instance
module.exports = new PolymarketQueue();
