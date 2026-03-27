'use strict';

const logger = require('./logger');

// ═══════════════════════════════════════
// GLOBAL AI REQUEST QUEUE
// ═══════════════════════════════════════
// Prevents Gemini rate limiting by:
//   1. Limiting concurrent requests
//   2. Spacing calls appropriately
//   3. Supporting priority queuing
//
// Gemini 2.5 Flash PREMIUM limits:
//   Paid tier:  1000 RPM, 4M TPM
//
// Aggressive but safe: ~200 RPM (12,000 calls/hour)
// ═══════════════════════════════════════

class AIQueue {
  constructor() {
    this.geminiQueue = [];
    this.geminiRunning = 0;
    this.geminiMaxConcurrent = 10;  // premium: 10 simultaneous calls
    this.geminiDelayMs = 300;       // 300ms between calls = ~200/min
    this.lastGeminiCall = 0;
    
    this.stats = {
      geminiCalls: 0,
      geminiErrors: 0,
      geminiQueued: 0,
      totalWaitTimeMs: 0,
      callsToday: 0,
      lastResetDate: new Date().toISOString().slice(0, 10)
    };
  }
  
  /**
   * Add a Gemini API call to the queue
   * @param {Function} fn - Async function that makes the Gemini API call
   * @param {string} priority - 'high' or 'normal' (default)
   * @returns {Promise} Resolves with the result of fn()
   */
  async enqueueGemini(fn, priority = 'normal') {
    return new Promise((resolve, reject) => {
      const task = {
        fn,
        resolve,
        reject,
        priority,
        added: Date.now()
      };
      
      // High priority goes to front of queue
      if (priority === 'high') {
        this.geminiQueue.unshift(task);
      } else {
        this.geminiQueue.push(task);
      }
      
      this.stats.geminiQueued = this.geminiQueue.length;
      this._processQueue();
    });
  }
  
  async _processQueue() {
    // Can't process if at max concurrency
    if (this.geminiRunning >= this.geminiMaxConcurrent) return;
    if (this.geminiQueue.length === 0) return;
    
    // Rate limit — ensure minimum delay between calls
    const now = Date.now();
    const timeSinceLast = now - this.lastGeminiCall;
    if (timeSinceLast < this.geminiDelayMs) {
      // Schedule retry after delay
      setTimeout(() => this._processQueue(), 
        this.geminiDelayMs - timeSinceLast);
      return;
    }
    
    const task = this.geminiQueue.shift();
    if (!task) return;
    
    // Track wait time
    const waitTime = Date.now() - task.added;
    this.stats.totalWaitTimeMs += waitTime;
    
    this.geminiRunning++;
    this.lastGeminiCall = Date.now();
    this.stats.geminiCalls++;
    this.stats.geminiQueued = this.geminiQueue.length;
    
    // Reset daily counter at midnight
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.stats.lastResetDate) {
      this.stats.callsToday = 0;
      this.stats.lastResetDate = today;
    }
    this.stats.callsToday++;
    
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (e) {
      this.stats.geminiErrors++;
      logger.warn('AIQueue: Gemini call failed', {
        error: e.message,
        queueDepth: this.geminiQueue.length
      });
      task.reject(e);
    } finally {
      this.geminiRunning--;
      this.stats.geminiQueued = this.geminiQueue.length;
      // Process next item in queue
      setTimeout(() => this._processQueue(), this.geminiDelayMs);
    }
  }
  
  getStats() {
    const avgWaitMs = this.stats.geminiCalls > 0
      ? Math.round(this.stats.totalWaitTimeMs / this.stats.geminiCalls)
      : 0;
    
    return {
      running: this.geminiRunning,
      queued: this.geminiQueue.length,
      calls: this.stats.geminiCalls,
      callsToday: this.stats.callsToday,
      errors: this.stats.geminiErrors,
      errorRate: this.stats.geminiCalls > 0
        ? parseFloat((this.stats.geminiErrors / this.stats.geminiCalls * 100).toFixed(1))
        : 0,
      avgWaitMs,
      maxConcurrent: this.geminiMaxConcurrent,
      delayMs: this.geminiDelayMs
    };
  }
  
  /**
   * Adjust queue parameters dynamically
   */
  setParams({ maxConcurrent, delayMs }) {
    if (maxConcurrent !== undefined) {
      this.geminiMaxConcurrent = Math.max(1, Math.min(10, maxConcurrent));
      logger.info('AIQueue: maxConcurrent updated', { maxConcurrent: this.geminiMaxConcurrent });
    }
    if (delayMs !== undefined) {
      this.geminiDelayMs = Math.max(500, Math.min(30000, delayMs));
      logger.info('AIQueue: delayMs updated', { delayMs: this.geminiDelayMs });
    }
  }
}

module.exports = new AIQueue();
