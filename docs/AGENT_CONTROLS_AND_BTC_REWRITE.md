# Agent Controls + BTCFastAgent Rewrite

## Summary of Changes

### 1. ✅ Agent On/Off Controls in Dashboard

Added the ability to start/stop individual agents from the dashboard without restarting the bot.

#### Changes Made:

**index.js**:
- Added BTCFastAgent to the agents array
- Exported `getAgents()` function for dashboard access

**dashboard/server.js**:
- Added `POST /api/agents/:name/toggle` endpoint
- Toggles agent.active state and calls start()/stop()

**dashboard/public/index.html**:
- Updated `renderAgents()` to add Start/Stop buttons
- Added `toggleAgent(name)` JavaScript function
- Buttons change color: green (Start) / red (Stop)
- Agent dot color reflects active state

#### How It Works:

1. **Dashboard displays each agent** with a toggle button
2. **Click button** → sends POST to `/api/agents/:name/toggle`
3. **Server toggles** agent.stop() or agent.start()
4. **Dashboard auto-updates** via WebSocket (no page refresh needed)

#### UI Design:

```
[Agent Card]
┌─────────────────────────────────────┐
│ ● CryptoAgent          [Stop Button]│
│ CRYPTO · 120s · Scans: 15            │
│ Last: 2:45:30 PM                     │
│ 10 Scout | 5 Pass | 5 Skip          │
└─────────────────────────────────────┘
```

**Active agent**: Green dot + Red "Stop" button  
**Stopped agent**: Gray dot + Green "Start" button

---

### 2. ✅ BTCFastAgent Complete Rewrite

Completely rewrote BTCFastAgent with a simpler, more robust approach.

#### Key Improvements:

**1. Better Price Data**:
- Uses `stateStore.btcPrice` (updated by newsFetcher)
- Fallbacks: CryptoCompare → CoinCap
- Removed complex Binance klines (too noisy)

**2. Simple Momentum Strategy**:
```javascript
Price history (5 readings) → momentum calculation
STRONG_UP:   +0.08%+ & upward moves → YES
UP:          +0.02%+ & upward moves → YES (if edge ≥5%)
STRONG_DOWN: -0.08%+ & downward moves → NO
DOWN:        -0.02%+ & downward moves → NO (if edge ≥5%)
NEUTRAL:     Skip
```

**3. Better Market Finding**:
- Search by question text (not slug)
- Handles "5 min", "5-min", "5min", "five min"
- Fallback: any "bitcoin" + "up or down" market
- Sorts by liquidity

**4. Trade Cooldown**:
- Max 1 trade per 5 minutes
- Prevents over-trading same market

**5. Smaller Stakes**:
- Cap at $3 per trade (was $5)
- Appropriate for high-frequency small markets

**6. Take-Profit Monitoring**:
- Checks open positions every 60s
- Alerts at 40%+ gain
- Ready for SELL execution (when implemented)

#### Code Structure:

```javascript
class BTCFastAgent {
  constructor() {
    priceHistory = []     // Rolling BTC prices
    lastTradeTime = 0     // Cooldown tracker
    minTimeBetweenTrades = 5 * 60 * 1000
  }
  
  async getBTCPrice()           // stateStore → CryptoCompare → CoinCap
  async findBTCMarket()         // Smart search with fallbacks
  getMomentum()                 // Calculate from price history
  decide(btcPrice, market, momentum) // Simple rule-based strategy
  async checkOpenPositions()    // Take-profit monitoring
  async scan()                  // Main loop
}
```

#### Scan Flow:

```
1. Check open positions for take-profit (40%+)
2. Get BTC price → add to history
3. Calculate momentum (need 3+ readings)
4. Check cooldown (5 min since last trade)
5. Find live BTC 5-min market
6. Make decision using momentum
7. Risk check (minEdge: 5%, minConfidence: 55%)
8. Execute if approved (max $3)
9. Update stateStore
```

#### Decision Logic:

```javascript
STRONG_UP momentum:
  → trueProbUp = min(80, marketProb + 20)
  → trade = YES
  
STRONG_DOWN momentum:
  → trueProbUp = max(20, marketProb - 20)
  → trade = NO
  
UP/DOWN momentum:
  → adjust by ±10%
  → trade only if edge ≥ 5%
  
NEUTRAL:
  → skip
```

#### Before vs After:

| Aspect | Old | New |
|--------|-----|-----|
| **Price Data** | Binance 1-min candles | stateStore + fallbacks |
| **Analysis** | Gemini AI | Simple momentum rules |
| **Market Finding** | Fixed slug | Smart text search |
| **Strategy** | Complex ML | Clean rule-based |
| **Stake** | $5 max | $3 max |
| **Cooldown** | None | 5 min between trades |
| **Code Lines** | ~340 | ~390 (cleaner) |

---

## Files Modified

1. ✅ `index.js` — Added BTCFastAgent to agents array + export
2. ✅ `dashboard/server.js` — Added /api/agents/:name/toggle endpoint
3. ✅ `dashboard/public/index.html` — Added toggle buttons + toggleAgent()
4. ✅ `agents/btcFastAgent.js` — Complete rewrite with momentum strategy

---

## Testing

### Test Agent Controls:
1. Start bot → dashboard shows all agents
2. Click "Stop" on an agent → dot turns gray, button turns green
3. Check logs: "Agent stopped — [name]"
4. Click "Start" → dot turns green/orange, button turns red
5. Agent resumes scanning

### Test BTCFastAgent:
1. Start bot → BTCFastAgent begins building price history
2. Wait 3 scans (3 minutes) → enough data for momentum
3. Check logs for: "BTCFastAgent scan" with price + momentum
4. If momentum is strong → decision made
5. If no BTC 5-min market → "no live BTC 5-min market"
6. Trade executes if edge ≥ 5%

---

## Benefits

### Agent Controls:
✅ **No bot restart needed** to enable/disable agents  
✅ **Granular control** — test one agent at a time  
✅ **Resource management** — disable unused agents  
✅ **Quick debugging** — isolate problem agents  

### BTCFastAgent:
✅ **Simpler** — No complex AI analysis, just momentum  
✅ **Faster** — Fewer API calls, quicker decisions  
✅ **More reliable** — Doesn't depend on Gemini availability  
✅ **Better risk management** — Trade cooldown prevents spam  
✅ **Easier to tune** — Clear parameters to adjust  

---

## Next Steps

1. **Monitor BTCFastAgent performance** — does momentum strategy work?
2. **Adjust thresholds** if needed:
   - Momentum thresholds (0.02%, 0.08%)
   - Edge requirement (5%)
   - Stake cap ($3)
   - Cooldown period (5 min)
3. **Implement SELL** in polymarketClient.placeOrder()
4. **Add agent stats** to dashboard (win rate per agent)

---

**Status**: ✅ Both features implemented and ready to test  
**Impact**: Better UX + more reliable BTC trading  
**Risk**: Low — graceful fallbacks everywhere
