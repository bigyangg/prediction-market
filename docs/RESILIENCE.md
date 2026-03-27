# Polybot Resilience Architecture

## Overview

This document describes the reliability improvements made to ensure the bot can run continuously for 24-72+ hours without supervision.

## New Modules

### 1. `core/resilience.js` - Central Resilience Utilities

Contains production patterns for long-running Node.js bots:

#### Global Error Handlers
```javascript
setupGlobalErrorHandlers({
  onShutdown: async () => { /* cleanup */ }
});
```
- `uncaughtException`: Logs and recovers from sync errors
- `unhandledRejection`: Handles promise rejections without crashing
- Distinguishes fatal errors (OOM) from recoverable ones (network timeouts)

#### Retry with Exponential Backoff
```javascript
await retryWithBackoff(
  () => api.placeOrder(order),
  { maxRetries: 3, baseDelay: 1000, operationName: 'placeOrder' }
);
```
- Delays: 1s → 2s → 4s → 8s (with 10% jitter)
- Smart retry logic: retries on 5xx/429/network errors, not on 400/401

#### Circuit Breaker
```javascript
const cb = new CircuitBreaker({
  name: 'polymarket-api',
  failureThreshold: 5,
  recoveryTimeout: 30000
});
await cb.execute(() => api.call());
```
- States: CLOSED → OPEN → HALF → CLOSED
- Prevents hammering failing services

#### Memory Monitor
```javascript
const monitor = new MemoryMonitor({
  warningThresholdMB: 400,
  criticalThresholdMB: 700
});
```
- Detects memory leaks over time
- Triggers GC when critical
- Logs warnings for investigation

#### Watchdog
```javascript
const watchdog = new Watchdog({
  staleThresholdMs: 10 * 60 * 1000, // 10 min
  onStale: () => { restartAgents(); }
});
watchdog.heartbeat('data-poll'); // Call on activity
```
- Detects frozen bots
- Triggers recovery actions

### 2. `core/tradeSafety.js` - Trade Safety Controls

#### Order Deduplication
```javascript
const { safe, idempotencyKey } = tradeSafety.preflightCheck({
  marketId: '0x123...',
  side: 'YES',
  amount: 10
});
if (safe) {
  tradeSafety.markOrderPending(idempotencyKey, order);
  // submit order
  tradeSafety.markOrderCompleted(idempotencyKey, orderId);
}
```
- Generates idempotency keys based on market+side+amount+timeWindow
- Prevents duplicate orders on retry

#### Trade Cooldowns
- Per-market cooldown: 30 seconds
- Global cooldown: 5 seconds between any trades
- Prevents rapid-fire trading bugs

#### Position Limits
- Max $100 per market
- Max $500 total exposure
- Auto-reduces order size to fit limits

### 3. `core/polymarketQueue.js` - API Rate Limiting

```javascript
await polymarketQueue.executeTrade(
  () => clobClient.postOrder(order),
  { operationName: 'postOrder', priority: 'high' }
);
```
- Separate queues for trades (strict) and market data (lenient)
- Max 3 concurrent trade API calls
- 500ms minimum between requests
- Integrated with circuit breaker

## Integration Points

### index.js Changes

```javascript
// Boot sequence now includes:
// 1. Global error handlers (first thing!)
// 2. Memory monitor
// 3. Watchdog
// 4. Original bot startup
// 5. Graceful shutdown cleanup
```

### Dashboard Updates

New system health indicators in the control bar:
- **MEM**: Heap memory usage (green/yellow/red)
- **API**: API queue depth
- **ORD**: Pending orders count
- **CB**: Circuit breaker state (OK/HALF/OPEN)

### Logger Updates

New log files (in `logs/` directory):
- `combined.log`: All info+ logs
- `trades.log`: Trade-specific events only
- `error.log`: Errors only
- `api.log`: API call logs only

## Why Each Pattern Matters

| Pattern | Problem Solved | What Happens Without It |
|---------|---------------|------------------------|
| Global Error Handlers | Unhandled errors crash Node | Bot dies silently at 3am |
| Retry with Backoff | Transient network failures | Single API hiccup stops trading |
| Circuit Breaker | Cascading failures | Bot hammers dead API for hours |
| Request Queue | Rate limit bans | API blocks your IP for 24h |
| Order Deduplication | Double orders on retry | You buy 2x what you intended |
| Cooldowns | Trading bugs / runaway loops | Bot drains balance in seconds |
| Position Limits | Concentration risk | All eggs in one basket |
| Memory Monitor | Memory leaks | OOM crash after 48 hours |
| Watchdog | Frozen promises | Bot sits idle indefinitely |

## Configuration

Add these to `.env` for customization:

```env
# Risk Management
MAX_STAKE_USD=20
MIN_STAKE_USD=1
DAILY_LOSS_LIMIT_USD=50
MAX_OPEN_TRADES=8

# Timeouts (ms)
API_TIMEOUT=10000
RETRY_BASE_DELAY=1000
RETRY_MAX_DELAY=30000

# Circuit Breaker
CB_FAILURE_THRESHOLD=5
CB_RECOVERY_TIMEOUT=30000
```

## Running for Extended Periods

### Windows-specific Tips

1. **Disable sleep/hibernate**: Settings → System → Power
2. **Use PM2 for process management**:
   ```bash
   npm install -g pm2
   pm2 start index.js --name polybot
   pm2 save
   ```
3. **Enable auto-restart on crash**:
   ```bash
   pm2 start index.js --name polybot --restart-delay=5000
   ```

### Monitoring

Check health via dashboard or API:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/state | jq '.tradeSafety, .polymarketQueue'
```

### Log Rotation

Logs auto-rotate at 10MB with 10 files retained. For longer runs:
```bash
# View recent errors
tail -100 logs/error.log

# Search for rate limits
grep -i "429\|rate" logs/api.log

# Check trade history
grep "trade\|order" logs/trades.log | tail -50
```
