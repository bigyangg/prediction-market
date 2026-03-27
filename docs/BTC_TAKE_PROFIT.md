# BTCFastAgent Auto Take-Profit Implementation

## Overview
Added position monitoring and take-profit detection for BTC 5-minute fast trades.

## Changes Made

### File: `agents/btcFastAgent.js`

#### 1. New Method: `checkOpenPositions()`
**Location**: Lines 138-185

**Functionality**:
- Scans all open trades belonging to BTCFastAgent
- Fetches current market prices from Polymarket
- Calculates real-time P&L percentage
- Logs position status
- Triggers take-profit alert at 40%+ gain
- Adds news feed entry when take-profit threshold hit

**Code Flow**:
```javascript
1. Filter stateStore.trades for open BTCFastAgent positions
2. For each position:
   a. Fetch current market data
   b. Get current price for the side (YES/NO)
   c. Calculate P&L: ((currentPrice - entryPrice) / entryPrice * 100)
   d. Log position status
   e. If P&L >= 40%:
      - Log take-profit signal
      - Add news feed alert
      - TODO: Execute SELL (pending placeOrder SELL support)
```

#### 2. Integration into `scan()` Method
**Location**: Line 260

**Change**:
```javascript
// 0. Check open positions for take-profit opportunities
await this.checkOpenPositions();
```

Called at the **start of each scan** (every 60 seconds) before looking for new trades.

## Take-Profit Logic

### Current Implementation (Monitoring Only)
- **Threshold**: 40% profit
- **Action**: Log + news feed alert
- **Frequency**: Checked every 60s during scan cycle

### Example Calculation
```javascript
// Entry
entryPrice = 0.50 (50¢)
stake = $5
position = 10 shares

// Current Market Price
currentPrice = 0.70 (70¢)

// P&L Calculation
pnlPct = ((0.70 - 0.50) / 0.50 * 100) = 40%

// Trigger: Take-profit signal logged
```

### Log Output
```
BTCFastAgent position check:
  market: "BTC 5min Up/Down..."
  entryPrice: 0.5
  currentPrice: 0.7
  pnlPct: 40.0%

BTCFastAgent: taking profit
  pnl: 40.0%
  market: "BTC 5min Up/Down..."
```

### News Feed
```
🎯 Take-profit signal: 40.0% gain — BTC 5min Up/Down...
```

## Future Enhancement: SELL Execution

**Current Status**: TODO placeholder at line 174

**Next Step**: Implement SELL in `core/polymarketClient.js`

Required additions to `placeOrder()`:
```javascript
async placeOrder(market, side, stake, options = {}) {
  // Current: only supports BUY
  // TODO: Add SELL support
  //   - Find existing position by conditionId
  //   - Calculate shares to sell
  //   - Create SELL order via CLOB
  //   - Update stateStore (position closed)
  
  if (side === 'SELL') {
    // Implementation needed
  }
}
```

## Benefits

✅ **Real-time monitoring** — Positions checked every 60s  
✅ **Early exit awareness** — Know when to take profit before auto-resolution  
✅ **Dashboard visibility** — News feed alerts for take-profit signals  
✅ **Risk management** — Lock in gains at 40%+ instead of waiting for resolution  
✅ **Flexible threshold** — Easy to adjust (currently 40%)  

## Configuration

To adjust take-profit threshold, edit line 169 in `btcFastAgent.js`:

```javascript
// Take profit at 40%+ gain
if (pnlPct >= 40) {
  // Change 40 to desired percentage
}
```

Suggested thresholds:
- **Conservative**: 30% (earlier exits, more frequent)
- **Balanced**: 40% (current setting)
- **Aggressive**: 50%+ (wait for bigger gains)

## Testing Recommendations

1. **Open a BTC 5min trade** via BTCFastAgent
2. **Wait for price movement** (or simulate with market data)
3. **Watch logs** at 60s intervals for position checks
4. **Verify alert** triggers when P&L >= 40%
5. **Check news feed** for take-profit notification

## Example Scenario

```
T+0:00 — Trade opened: YES @ $0.50, stake $5
T+1:00 — Position check: current $0.55, P&L +10%
T+2:00 — Position check: current $0.62, P&L +24%
T+3:00 — Position check: current $0.71, P&L +42%
         → 🎯 Take-profit signal triggered!
         → News feed alert created
         → TODO: SELL order (pending implementation)
T+5:00 — Market auto-resolves
```

## Error Handling

- **Missing market data**: Silently skip (continue checking other positions)
- **API failures**: Logged at debug level, doesn't crash scan
- **Empty positions array**: Early return, no API calls
- **Parse errors**: Caught and logged, scan continues

## Performance Impact

**Minimal** — Only runs when:
1. BTCFastAgent is active
2. Open positions exist
3. Once per 60s scan cycle

Typical cost: 1 API call per open position per minute

---

**Status**: ✅ Monitoring implemented (SELL execution pending)  
**Impact**: Better risk management for fast BTC trades  
**Next**: Add SELL support to polymarketClient.placeOrder()
