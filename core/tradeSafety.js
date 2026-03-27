'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TRADE SAFETY MODULE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Production patterns for safe order execution:
 * 
 *   1. Order deduplication - Prevents duplicate orders on retry
 *   2. Trade cooldowns - Prevents rapid-fire trading
 *   3. Position limits - Max exposure per market
 *   4. Order tracking - In-memory state of pending/open orders
 *   5. Pre-flight checks - Validates order before submission
 * 
 * WHY EACH PATTERN MATTERS:
 * 
 * - Deduplication: If you submit an order, the request times out but succeeds,
 *   a naive retry creates a duplicate. We track idempotency keys.
 * 
 * - Cooldowns: Prevents emotional/buggy rapid trading. If you just traded a
 *   market, wait N seconds before trading it again.
 * 
 * - Position limits: Don't put all eggs in one basket. Max exposure per market.
 * 
 * - Order tracking: Know what's pending, what's filled, what failed.
 * 
 * - Pre-flight checks: Validate balance, market status, etc. before submitting.
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 */

const logger = require('./logger');
const { OrderDeduplicator } = require('./resilience');

class TradeSafety {
  constructor(options = {}) {
    // Order deduplication
    this.deduplicator = new OrderDeduplicator({
      ttlMs: 10 * 60 * 1000  // 10 minute window for duplicate detection
    });

    // Trade cooldowns per market (marketId → lastTradeTimestamp)
    this.cooldowns = new Map();
    this.cooldownMs = options.cooldownMs || 30 * 1000;  // 30 seconds default
    this.globalCooldownMs = options.globalCooldownMs || 5 * 1000;  // 5s between any trades
    this.lastGlobalTrade = 0;

    // Pending orders (orderId → orderData)
    this.pendingOrders = new Map();
    this.maxPendingOrders = options.maxPendingOrders || 10;

    // Position tracking (marketId → exposure in USD)
    this.positions = new Map();
    this.maxPositionPerMarket = options.maxPositionPerMarket || 100;  // $100 max per market
    this.maxTotalExposure = options.maxTotalExposure || 500;  // $500 total

    // Stats
    this.stats = {
      ordersSubmitted: 0,
      ordersCompleted: 0,
      ordersFailed: 0,
      duplicatesPrevented: 0,
      cooldownsHit: 0,
      positionLimitsHit: 0
    };

    // Cleanup old cooldowns every minute
    this._cleanupTimer = setInterval(() => this._cleanup(), 60000);

    logger.info('[TradeSafety] Initialized', {
      cooldownMs: this.cooldownMs,
      maxPendingOrders: this.maxPendingOrders,
      maxPositionPerMarket: this.maxPositionPerMarket,
      maxTotalExposure: this.maxTotalExposure
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRE-FLIGHT CHECKS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run all safety checks before submitting an order
   * Returns { safe: boolean, reason?: string }
   */
  preflightCheck(order) {
    const { marketId, side, amount } = order;

    // 1. Check for duplicate order
    const idempotencyKey = this.deduplicator.generateKey(marketId, side, amount);
    if (!this.deduplicator.canSubmit(idempotencyKey)) {
      this.stats.duplicatesPrevented++;
      return { safe: false, reason: 'Duplicate order detected (retry window active)' };
    }

    // 2. Check market cooldown
    const cooldownStatus = this.checkCooldown(marketId);
    if (!cooldownStatus.canTrade) {
      this.stats.cooldownsHit++;
      return { safe: false, reason: cooldownStatus.reason };
    }

    // 3. Check pending order limit
    if (this.pendingOrders.size >= this.maxPendingOrders) {
      return { safe: false, reason: `Max pending orders reached (${this.maxPendingOrders})` };
    }

    // 4. Check position limits
    const positionCheck = this.checkPositionLimits(marketId, amount);
    if (!positionCheck.allowed) {
      this.stats.positionLimitsHit++;
      return { safe: false, reason: positionCheck.reason };
    }

    return { 
      safe: true, 
      idempotencyKey,
      suggestedAmount: positionCheck.suggestedAmount 
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COOLDOWNS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if enough time has passed since last trade on this market
   */
  checkCooldown(marketId) {
    const now = Date.now();

    // Global cooldown (between any trades)
    const globalElapsed = now - this.lastGlobalTrade;
    if (globalElapsed < this.globalCooldownMs) {
      const waitSecs = ((this.globalCooldownMs - globalElapsed) / 1000).toFixed(1);
      return { 
        canTrade: false, 
        reason: `Global cooldown: wait ${waitSecs}s` 
      };
    }

    // Per-market cooldown
    const lastTrade = this.cooldowns.get(marketId);
    if (lastTrade) {
      const elapsed = now - lastTrade;
      if (elapsed < this.cooldownMs) {
        const waitSecs = ((this.cooldownMs - elapsed) / 1000).toFixed(1);
        return { 
          canTrade: false, 
          reason: `Market cooldown: wait ${waitSecs}s before trading ${marketId.slice(0, 8)}... again` 
        };
      }
    }

    return { canTrade: true };
  }

  /**
   * Record that a trade was made (start cooldown timer)
   */
  recordTrade(marketId) {
    const now = Date.now();
    this.cooldowns.set(marketId, now);
    this.lastGlobalTrade = now;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POSITION LIMITS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if order would exceed position limits
   */
  checkPositionLimits(marketId, amount) {
    const currentPosition = this.positions.get(marketId) || 0;
    const newPosition = currentPosition + amount;

    // Check per-market limit
    if (newPosition > this.maxPositionPerMarket) {
      const available = this.maxPositionPerMarket - currentPosition;
      if (available <= 0) {
        return { 
          allowed: false, 
          reason: `Max position reached for this market ($${this.maxPositionPerMarket})` 
        };
      }
      return { 
        allowed: true, 
        suggestedAmount: available,
        reason: `Reduced to $${available} (market limit)` 
      };
    }

    // Check total exposure
    const totalExposure = Array.from(this.positions.values()).reduce((a, b) => a + b, 0);
    if (totalExposure + amount > this.maxTotalExposure) {
      const available = this.maxTotalExposure - totalExposure;
      if (available <= 0) {
        return { 
          allowed: false, 
          reason: `Max total exposure reached ($${this.maxTotalExposure})` 
        };
      }
      return { 
        allowed: true, 
        suggestedAmount: Math.min(amount, available),
        reason: `Reduced to $${available} (total exposure limit)` 
      };
    }

    return { allowed: true, suggestedAmount: amount };
  }

  /**
   * Update position after trade execution
   */
  updatePosition(marketId, amount) {
    const current = this.positions.get(marketId) || 0;
    this.positions.set(marketId, current + amount);
  }

  /**
   * Sync positions from external source (e.g., Polymarket API)
   */
  syncPositions(positionsArray) {
    this.positions.clear();
    for (const pos of positionsArray) {
      if (pos.marketId && pos.size) {
        this.positions.set(pos.marketId, parseFloat(pos.size) || 0);
      }
    }
    logger.debug('[TradeSafety] Positions synced', { count: this.positions.size });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ORDER LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark order as pending (about to submit)
   */
  markOrderPending(idempotencyKey, orderData) {
    this.deduplicator.markPending(idempotencyKey);
    this.pendingOrders.set(idempotencyKey, {
      ...orderData,
      status: 'pending',
      submittedAt: Date.now()
    });
    this.stats.ordersSubmitted++;
  }

  /**
   * Mark order as completed (filled or partially filled)
   */
  markOrderCompleted(idempotencyKey, orderId, fillData = {}) {
    this.deduplicator.markCompleted(idempotencyKey, orderId);
    this.pendingOrders.delete(idempotencyKey);
    this.stats.ordersCompleted++;
    
    // Update position
    if (fillData.marketId && fillData.amount) {
      this.updatePosition(fillData.marketId, fillData.amount);
    }
    
    // Record cooldown
    if (fillData.marketId) {
      this.recordTrade(fillData.marketId);
    }
  }

  /**
   * Mark order as failed
   */
  markOrderFailed(idempotencyKey, error) {
    this.deduplicator.markFailed(idempotencyKey, error);
    this.pendingOrders.delete(idempotencyKey);
    this.stats.ordersFailed++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP & STATS
  // ═══════════════════════════════════════════════════════════════════════════

  _cleanup() {
    const now = Date.now();
    const expiryMs = 10 * 60 * 1000;  // 10 minutes

    // Clean old cooldowns
    for (const [marketId, timestamp] of this.cooldowns.entries()) {
      if (now - timestamp > expiryMs) {
        this.cooldowns.delete(marketId);
      }
    }

    // Clean stale pending orders (shouldn't happen, but safety)
    for (const [key, order] of this.pendingOrders.entries()) {
      if (now - order.submittedAt > expiryMs) {
        logger.warn('[TradeSafety] Removing stale pending order', { key });
        this.pendingOrders.delete(key);
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      pendingOrders: this.pendingOrders.size,
      activeCooldowns: this.cooldowns.size,
      trackedPositions: this.positions.size,
      totalExposure: Array.from(this.positions.values()).reduce((a, b) => a + b, 0),
      deduplicator: this.deduplicator.getStats()
    };
  }

  getPendingOrders() {
    return Array.from(this.pendingOrders.values());
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    this.deduplicator.destroy();
  }
}

// Singleton instance
module.exports = new TradeSafety();
