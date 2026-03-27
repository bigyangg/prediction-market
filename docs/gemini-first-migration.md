# Gemini-First Pipeline Migration

## Overview

Version 2.2.0 introduces a major architectural change to reduce API costs by 92% while maintaining trading quality.

## What Changed

### Before (v2.1)
```
Market → Haiku Scout → Sonnet Judge → Gemini Validator → Execute
         (100%)         (100%)         (approved only)
         
Cost: ~100 Sonnet calls/day × $0.015 = $1.50/day = $45/month
```

### After (v2.2)
```
Market → Haiku Scout → Gemini Judge → Sonnet Arbiter → Gemini Validator → Execute
         (100%)        (100%)         (5% - exceptional only)  (approved only)
         
Cost: ~100 Gemini calls/day × $0.0005 + ~5 Sonnet calls/day × $0.015
    = $0.05 + $0.075 = $0.125/day = $3.75/month
    
Savings: $45 → $3.75 (92% reduction)
```

## Pipeline Logic

### Step 1: Haiku Scout (unchanged)
- Filters out low-quality markets
- Same as before

### Step 2: Gemini Judge (NEW - Primary Analyst)
- **Every approved market** is analyzed by Gemini 2.5 Flash
- Uses live web search for current information
- Gets same comprehensive prompt as Sonnet previously had
- Includes sharp trader signals from on-chain data

### Step 3: Sonnet Arbiter (NEW - Selective)
Sonnet now runs ONLY when Gemini finds exceptional edge:
- Edge ≥ 10%
- Confidence ≥ 70%
- Liquidity ≥ $200,000
- **Estimated frequency: ~5% of markets**

When Sonnet runs:
- **Both agree** → Confidence +10, mark as `dualConfirmed`, use this decision
- **Both disagree** → Use Gemini's decision, Confidence -10

### Step 4: Gemini Validator (unchanged)
- Final veto check using live web search
- Same as before

## Why Gemini-First?

### Cost
- **97% cheaper per call**: $0.0005 vs $0.015
- **Built-in web search**: No separate news API needed
- **Same safety**: Gemini Validator still has veto power

### Quality
- Gemini 2.5 Flash is highly capable for market analysis
- Sonnet still validates the highest-conviction trades (the ones that matter most)
- Dual confirmation on big trades provides extra safety

### Performance
- Slightly faster response times (Gemini is faster than Sonnet)
- Less rate limit exposure on Anthropic API

## Technical Changes

### Files Modified

1. **`core/geminiJudge.js`**
   - Enhanced prompt with full market context, news, sharp signals
   - Added `sharpSignals` parameter to `analyze(market, context, sharpSignals)`
   - Enabled Google Search tool (`tools: [{ googleSearch: {} }]`)
   - Increased max tokens to 300

2. **`agents/baseAgent.js`**
   - Complete rewrite of scan() loop
   - New logic: try Gemini first, then selectively call Sonnet
   - Added cost tracking (increments `stateStore.sessionCost`)
   - Logs cost milestones every $1

3. **`core/riskManager.js`**
   - Lowered minEdge: 5 → 4 (Gemini is slightly more conservative)
   - Lowered minConf: 62 → 55

4. **`core/stateStore.js`**
   - Added `sessionCost` property (tracks estimated API cost)
   - Exposed in `snapshot()` for dashboard

5. **`dashboard/public/index.html`**
   - Added "Est. API Cost" metric card
   - Shows session total

## Migration Guide

### For Users

**No action required.** Simply pull latest code and restart:

```bash
git pull
npm start
```

You'll see new log patterns:
```
[BaseAgent] Sending 5 approved markets to GeminiJudge
GeminiJudge decision { trade: 'YES', edge: 12, confidence: 75 }
High conviction — requesting Sonnet arbiter
DUAL CONFIRMED { trade: 'YES', edge: 12, geminiConf: 75, sonnetTrade: 'YES' }
Cost milestone { total: '$1.00', model: 'dual' }
```

### For Developers

If you've customized the agent pipeline, review:
- `agents/baseAgent.js` lines 269-349 (new scan loop)
- `core/geminiJudge.js` lines 84-153 (enhanced analyze method)

## Expected Behavior

### Common Paths

**Path 1: Gemini Only (95% of markets)**
```
Haiku Scout ✓ → Gemini Judge (YES, edge 6%, conf 65%) → RiskManager → Execute
Model used: 'gemini'
Cost: $0.001 + $0.0005 = $0.0015
```

**Path 2: Dual Confirmation (3-5% of markets)**
```
Haiku Scout ✓ → Gemini Judge (YES, edge 12%, conf 75%) → 
  Sonnet Arbiter (YES, edge 11%, conf 80%) → 
  Confidence boosted to 85%, dualConfirmed: true → Execute
Model used: 'dual'
Cost: $0.001 + $0.0005 + $0.015 = $0.0165
```

**Path 3: Disagreement (<1% of markets)**
```
Haiku Scout ✓ → Gemini Judge (YES, edge 10%, conf 70%) → 
  Sonnet Arbiter (NO, edge 5%, conf 65%) → 
  Use Gemini but reduce confidence to 60% → RiskManager → Execute or Skip
Model used: 'gemini'
Cost: $0.001 + $0.0005 + $0.015 = $0.0165
```

**Path 4: Gemini Unavailable**
```
Haiku Scout ✓ → Gemini Judge (unavailable) → Sonnet Judge → Execute
Model used: 'sonnet'
Cost: $0.001 + $0.015 = $0.016
```

## Dashboard Changes

### New Metric: "Est. API Cost"

Located in the top metrics row:
```
┌─────────────────┐
│ Est. API Cost   │
│   $1.23         │
│ session total   │
└─────────────────┘
```

This tracks estimated cost for:
- Haiku: $0.001/call
- Gemini: $0.0005/call
- Sonnet: $0.015/call

### Log Milestones

Every $1 spent logs:
```json
{
  "message": "Cost milestone",
  "total": "$1.00",
  "model": "gemini"
}
```

## FAQ

### Why not use Gemini exclusively?

Sonnet still provides value on the highest-conviction trades where additional validation is worth the cost. The dual-confirmation pattern catches subtle reasoning errors.

### What if Gemini API goes down?

The system automatically falls back to Sonnet as primary judge. You'll see:
```
GeminiJudge: 3 failures — cooling 5 min
[BaseAgent] Gemini unavailable — using Sonnet
```

### Can I revert to Sonnet-first?

Yes, but not recommended. To revert, modify `agents/baseAgent.js` line 277-349 to always call `_callSonnet()` first.

### Will this affect win rate?

Early testing shows no significant change in win rate. Gemini has comparable analysis quality to Sonnet for market prediction tasks, and Sonnet still validates the most important trades.

### How do I track model usage?

Check the dashboard under "Gemini Judge" and the new "Est. API Cost" metric. Logs also show which model made each decision:
```
decision._model: 'gemini' | 'sonnet' | 'dual'
```

## Support

For issues or questions:
1. Check logs for `GeminiJudge` and `[BaseAgent]` entries
2. Verify Gemini API key is set: `GEMINI_API_KEY=...`
3. Review dashboard "Est. API Cost" to confirm cost reduction
4. Open an issue with log excerpts showing unexpected behavior

## Version History

- **2.2.0** - Gemini-first pipeline (current)
- **2.1.0** - Critical bug fixes (order placement, balance, precision)
- **2.0.0** - Initial release with Sonnet-first pipeline
