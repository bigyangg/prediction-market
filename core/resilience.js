'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESILIENCE MODULE - Production Patterns for Long-Running Node.js Bots
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * This module provides:
 *   1. Global error handlers (uncaughtException, unhandledRejection)
 *   2. Retry with exponential backoff for API calls
 *   3. Circuit breaker pattern for failing services
 *   4. Rate limiter / request queue for API calls
 *   5. Memory monitoring and GC triggers
 *   6. Order deduplication / idempotency
 * 
 * WHY EACH PATTERN MATTERS:
 * 
 * - uncaughtException: Prevents silent crashes. Logs the error, attempts
 *   graceful shutdown, and ensures you know what happened.
 * 
 * - unhandledRejection: Same for promises. Without this, a rejected promise
 *   with no .catch() will crash Node 15+ or silently fail in older versions.
 * 
 * - Exponential backoff: Prevents hammering a failing API. If an API is down
 *   or rate-limited, exponential backoff reduces load and gives it time to recover.
 * 
 * - Circuit breaker: If an API fails repeatedly, stop calling it for a period.
 *   This prevents cascading failures and wasted resources.
 * 
 * - Request queue: Polymarket has rate limits. A queue ensures you never exceed
 *   them, even under heavy load.
 * 
 * - Memory monitoring: Long-running processes can leak memory. Periodic checks
 *   help catch leaks before they cause OOM crashes.
 * 
 * - Idempotency: Prevents duplicate orders when retrying failed submissions.
 *   Each order gets a unique key; if we see the same key twice, we skip.
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 */

const logger = require('./logger');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════
// 1. GLOBAL ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

let shutdownInProgress = false;

function setupGlobalErrorHandlers(options = {}) {
  const { onShutdown } = options;

  // Handle uncaught exceptions
  process.on('uncaughtException', async (error, origin) => {
    logger.error('UNCAUGHT EXCEPTION - Bot will attempt recovery', {
      error: error.message,
      stack: error.stack,
      origin,
      timestamp: new Date().toISOString()
    });

    // Write to stderr as backup in case logger fails
    console.error('[FATAL] Uncaught Exception:', error);

    // Attempt graceful shutdown only for truly fatal errors
    if (isFatalError(error)) {
      await gracefulShutdown('uncaughtException', onShutdown);
    }
    // Non-fatal: log and continue (e.g., ECONNRESET, EPIPE)
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED REJECTION - Continuing operation', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      timestamp: new Date().toISOString()
    });

    // Most unhandled rejections are recoverable (failed API calls, etc.)
    // Log but don't crash
  });

  // Handle warnings (useful for debugging deprecations)
  process.on('warning', (warning) => {
    logger.warn('Node.js Warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack
    });
  });

  // Handle SIGTERM (sent by process managers, Docker, etc.)
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', onShutdown));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', onShutdown));

  logger.info('[Resilience] Global error handlers installed');
}

function isFatalError(error) {
  // Only truly fatal errors that indicate corrupted state
  const fatalPatterns = [
    'out of memory',
    'heap out of memory',
    'ENOMEM',
    'Maximum call stack',
    'ERR_INTERNAL_ASSERTION'
  ];
  
  const msg = error.message?.toLowerCase() || '';
  return fatalPatterns.some(p => msg.includes(p.toLowerCase()));
}

async function gracefulShutdown(signal, onShutdown) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  logger.info(`[Resilience] Graceful shutdown initiated (${signal})`);

  try {
    // Give pending operations 5 seconds to complete
    if (typeof onShutdown === 'function') {
      await Promise.race([
        onShutdown(),
        new Promise(r => setTimeout(r, 5000))
      ]);
    }
  } catch (e) {
    logger.error('[Resilience] Error during shutdown', { error: e.message });
  }

  logger.info('[Resilience] Shutdown complete');
  process.exit(0);
}


// ═══════════════════════════════════════════════════════════════════════════
// 2. RETRY WITH EXPONENTIAL BACKOFF
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Retries an async function with exponential backoff.
 * 
 * WHY: API calls fail. Networks are unreliable. Rate limits happen.
 * Exponential backoff gives the API time to recover without hammering it.
 * 
 * Formula: delay = baseDelay * (2 ^ attempt) + jitter
 * Example: 1s → 2s → 4s → 8s (with ±10% jitter to prevent thundering herd)
 * 
 * @param {Function} fn - Async function to retry
 * @param {Object} options
 * @param {number} options.maxRetries - Max retry attempts (default: 3)
 * @param {number} options.baseDelay - Initial delay in ms (default: 1000)
 * @param {number} options.maxDelay - Maximum delay cap in ms (default: 30000)
 * @param {Function} options.shouldRetry - Custom retry condition
 * @param {string} options.operationName - For logging
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    shouldRetry = defaultShouldRetry,
    operationName = 'operation'
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        logger.error(`[Retry] ${operationName} failed after ${attempt + 1} attempts`, {
          error: error.message,
          status: error.response?.status
        });
        throw error;
      }

      // Calculate delay with jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = exponentialDelay * 0.1 * Math.random();
      const delay = Math.min(exponentialDelay + jitter, maxDelay);

      logger.warn(`[Retry] ${operationName} attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms`, {
        error: error.message,
        status: error.response?.status
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

function defaultShouldRetry(error) {
  // Don't retry on authentication errors
  if (error.response?.status === 401 || error.response?.status === 403) {
    return false;
  }
  // Don't retry on validation errors (bad request)
  if (error.response?.status === 400) {
    return false;
  }
  // Retry on network errors, timeouts, 429, 5xx
  const status = error.response?.status;
  const isServerError = status >= 500 && status < 600;
  const isRateLimit = status === 429;
  const isNetworkError = ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED']
    .includes(error.code);
  
  return isServerError || isRateLimit || isNetworkError;
}


// ═══════════════════════════════════════════════════════════════════════════
// 3. CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Prevents cascading failures by stopping calls to a failing service.
 * 
 * States:
 *   CLOSED  - Normal operation, requests pass through
 *   OPEN    - Service is failing, reject immediately
 *   HALF    - Testing if service recovered, allow one request
 * 
 * WHY: If Polymarket API is down, don't keep hammering it. Open the circuit,
 * wait for recovery, then gradually resume.
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold || 5;    // failures before opening
    this.recoveryTimeout = options.recoveryTimeout || 30000;  // ms to wait before testing
    this.monitorInterval = options.monitorInterval || 10000;  // reset window

    this.state = 'CLOSED';
    this.failures = 0;
    this.lastFailure = 0;
    this.successes = 0;
  }

  async execute(fn) {
    // Check if circuit should transition from OPEN to HALF
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure >= this.recoveryTimeout) {
        this.state = 'HALF';
        logger.info(`[CircuitBreaker.${this.name}] State: OPEN → HALF (testing recovery)`);
      } else {
        throw new Error(`Circuit breaker OPEN for ${this.name}`);
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    }
  }

  _onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF') {
      this.state = 'CLOSED';
      logger.info(`[CircuitBreaker.${this.name}] State: HALF → CLOSED (service recovered)`);
    }
  }

  _onFailure() {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.state === 'HALF') {
      this.state = 'OPEN';
      logger.warn(`[CircuitBreaker.${this.name}] State: HALF → OPEN (recovery failed)`);
    } else if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      logger.warn(`[CircuitBreaker.${this.name}] State: CLOSED → OPEN (threshold reached)`, {
        failures: this.failures
      });
    }
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null
    };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 4. REQUEST QUEUE / RATE LIMITER
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Queues requests to respect API rate limits.
 * 
 * WHY: Polymarket has rate limits. Exceeding them gets you temporarily banned.
 * A queue ensures requests are spaced appropriately.
 * 
 * This is separate from aiQueue.js which handles Gemini. Each API gets its own
 * queue with appropriate limits.
 */
class RequestQueue {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.maxConcurrent = options.maxConcurrent || 5;
    this.minDelayMs = options.minDelayMs || 100;       // minimum time between requests
    this.maxQueueSize = options.maxQueueSize || 100;   // prevent unbounded growth
    
    this.queue = [];
    this.running = 0;
    this.lastRequest = 0;
    
    this.stats = {
      totalRequests: 0,
      completed: 0,
      failed: 0,
      rejected: 0,      // rejected due to full queue
      avgWaitMs: 0,
      totalWaitMs: 0
    };
  }

  /**
   * Add a request to the queue
   * @param {Function} fn - Async function to execute
   * @param {string} priority - 'high' or 'normal'
   */
  async enqueue(fn, priority = 'normal') {
    // Reject if queue is full (back-pressure)
    if (this.queue.length >= this.maxQueueSize) {
      this.stats.rejected++;
      throw new Error(`Request queue ${this.name} is full (${this.maxQueueSize})`);
    }

    return new Promise((resolve, reject) => {
      const task = {
        fn,
        resolve,
        reject,
        priority,
        added: Date.now()
      };

      if (priority === 'high') {
        this.queue.unshift(task);
      } else {
        this.queue.push(task);
      }

      this._process();
    });
  }

  async _process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    // Rate limit - ensure minimum delay between requests
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    if (elapsed < this.minDelayMs) {
      setTimeout(() => this._process(), this.minDelayMs - elapsed);
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    // Track wait time
    const waitTime = Date.now() - task.added;
    this.stats.totalWaitMs += waitTime;
    this.stats.totalRequests++;

    this.running++;
    this.lastRequest = Date.now();

    try {
      const result = await task.fn();
      this.stats.completed++;
      task.resolve(result);
    } catch (error) {
      this.stats.failed++;
      task.reject(error);
    } finally {
      this.running--;
      this.stats.avgWaitMs = Math.round(this.stats.totalWaitMs / this.stats.totalRequests);
      // Process next item
      setTimeout(() => this._process(), this.minDelayMs);
    }
  }

  getStats() {
    return {
      name: this.name,
      queued: this.queue.length,
      running: this.running,
      ...this.stats
    };
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 5. ORDER DEDUPLICATION / IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Prevents duplicate orders when retrying failed submissions.
 * 
 * WHY: If you submit an order, the request times out, but the order actually
 * went through, a naive retry would create a duplicate. This tracker uses
 * idempotency keys to detect and prevent that.
 * 
 * Pattern:
 *   1. Generate unique key for each order (market + side + amount + timestamp bucket)
 *   2. Check if key exists before submitting
 *   3. Mark key as pending during submission
 *   4. Mark as completed/failed after result
 *   5. Auto-expire old keys to prevent memory leak
 */
class OrderDeduplicator {
  constructor(options = {}) {
    this.orders = new Map();  // key → { status, timestamp, orderId }
    this.ttlMs = options.ttlMs || 5 * 60 * 1000;  // 5 minutes
    this.cleanupInterval = options.cleanupInterval || 60 * 1000;
    
    // Periodic cleanup to prevent memory leak
    this._cleanupTimer = setInterval(() => this._cleanup(), this.cleanupInterval);
  }

  /**
   * Generate idempotency key for an order
   * Bucket timestamp to 10-second windows to catch retries
   */
  generateKey(marketId, side, amount) {
    const timeBucket = Math.floor(Date.now() / 10000);  // 10-second buckets
    const raw = `${marketId}:${side}:${amount}:${timeBucket}`;
    return crypto.createHash('md5').update(raw).digest('hex').slice(0, 16);
  }

  /**
   * Check if order can be submitted (not already pending/completed)
   */
  canSubmit(key) {
    const existing = this.orders.get(key);
    if (!existing) return true;
    
    // Allow retry if previous attempt failed
    if (existing.status === 'failed') return true;
    
    // Block if pending or completed
    return false;
  }

  /**
   * Mark order as pending (about to submit)
   */
  markPending(key) {
    this.orders.set(key, {
      status: 'pending',
      timestamp: Date.now(),
      orderId: null
    });
  }

  /**
   * Mark order as completed
   */
  markCompleted(key, orderId) {
    this.orders.set(key, {
      status: 'completed',
      timestamp: Date.now(),
      orderId
    });
  }

  /**
   * Mark order as failed
   */
  markFailed(key, error) {
    this.orders.set(key, {
      status: 'failed',
      timestamp: Date.now(),
      error: error.message
    });
  }

  /**
   * Clean up expired entries
   */
  _cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of this.orders.entries()) {
      if (now - value.timestamp > this.ttlMs) {
        this.orders.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`[OrderDeduplicator] Cleaned ${cleaned} expired entries`);
    }
  }

  getStats() {
    let pending = 0, completed = 0, failed = 0;
    for (const v of this.orders.values()) {
      if (v.status === 'pending') pending++;
      else if (v.status === 'completed') completed++;
      else if (v.status === 'failed') failed++;
    }
    return { total: this.orders.size, pending, completed, failed };
  }

  destroy() {
    clearInterval(this._cleanupTimer);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 6. MEMORY MONITORING
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Monitors heap usage and triggers warnings/GC.
 * 
 * WHY: Long-running Node.js processes can leak memory slowly. By monitoring
 * heap usage, you can detect leaks early and trigger garbage collection
 * before OOM crashes.
 */
class MemoryMonitor {
  constructor(options = {}) {
    this.warningThresholdMB = options.warningThresholdMB || 500;
    this.criticalThresholdMB = options.criticalThresholdMB || 800;
    this.checkIntervalMs = options.checkIntervalMs || 60000;
    
    this.history = [];
    this.maxHistory = 60;  // 60 samples = 1 hour at 1min intervals
    
    this._timer = setInterval(() => this._check(), this.checkIntervalMs);
    this._check();  // Initial check
  }

  _check() {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    
    this.history.push({ timestamp: Date.now(), heapMB, rssMB });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    
    // Check for leak (consistently increasing over last 10 samples)
    if (this.history.length >= 10) {
      const recent = this.history.slice(-10);
      const isIncreasing = recent.every((v, i) => 
        i === 0 || v.heapMB >= recent[i - 1].heapMB
      );
      
      if (isIncreasing) {
        logger.warn('[MemoryMonitor] Possible memory leak detected', {
          startMB: recent[0].heapMB,
          currentMB: heapMB
        });
      }
    }
    
    // Critical threshold
    if (heapMB > this.criticalThresholdMB) {
      logger.error('[MemoryMonitor] CRITICAL: Heap usage above threshold', {
        heapMB,
        threshold: this.criticalThresholdMB
      });
      
      // Force garbage collection if exposed
      if (global.gc) {
        logger.info('[MemoryMonitor] Forcing garbage collection');
        global.gc();
      }
    } else if (heapMB > this.warningThresholdMB) {
      logger.warn('[MemoryMonitor] High heap usage', { heapMB });
    }
  }

  getStats() {
    const usage = process.memoryUsage();
    return {
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
      rssMB: Math.round(usage.rss / 1024 / 1024),
      externalMB: Math.round(usage.external / 1024 / 1024),
      history: this.history.slice(-10)
    };
  }

  destroy() {
    clearInterval(this._timer);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// 7. WATCHDOG
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Monitors bot health and restarts stuck components.
 * 
 * WHY: Long-running bots can get stuck (deadlocks, frozen promises, etc.)
 * A watchdog periodically checks that the bot is making progress and
 * restarts it if needed.
 */
class Watchdog {
  constructor(options = {}) {
    this.checkIntervalMs = options.checkIntervalMs || 60000;
    this.staleThresholdMs = options.staleThresholdMs || 300000;  // 5 minutes
    this.onStale = options.onStale || (() => {});
    
    this.lastActivity = Date.now();
    this.activityCount = 0;
    
    this._timer = setInterval(() => this._check(), this.checkIntervalMs);
  }

  /**
   * Call this whenever the bot does something meaningful
   * (API call, trade execution, market scan, etc.)
   */
  heartbeat(activity = 'unknown') {
    this.lastActivity = Date.now();
    this.activityCount++;
  }

  _check() {
    const staleMs = Date.now() - this.lastActivity;
    
    if (staleMs > this.staleThresholdMs) {
      logger.warn('[Watchdog] Bot appears stale', {
        staleSecs: Math.round(staleMs / 1000),
        lastActivity: new Date(this.lastActivity).toISOString()
      });
      this.onStale();
    }
  }

  getStats() {
    return {
      lastActivity: new Date(this.lastActivity).toISOString(),
      staleSecs: Math.round((Date.now() - this.lastActivity) / 1000),
      activityCount: this.activityCount
    };
  }

  destroy() {
    clearInterval(this._timer);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps a function with timeout protection
 * WHY: Prevents infinite hangs on API calls
 */
async function withTimeout(fn, timeoutMs, operationName = 'operation') {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  setupGlobalErrorHandlers,
  gracefulShutdown,
  retryWithBackoff,
  CircuitBreaker,
  RequestQueue,
  OrderDeduplicator,
  MemoryMonitor,
  Watchdog,
  withTimeout,
  sleep
};
