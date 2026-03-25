# Polybot v2.1 — Bug Fixes Summary

This document provides a quick reference for the critical fixes applied in version 2.1.

---

## 🔴 Critical Fixes

### 1. Order Placement Bug (HIGH SEVERITY)

**Symptom**: NO trades executed as SELL instead of BUY

**Impact**: Positions placed opposite to agent intent

**Fix**: 
- Location: `agents/baseAgent.js` line 711
- Change: Always use `side: 'BUY'` with correct token selection
- YES → BUY token[0] (YES token)
- NO → BUY token[1] (NO token)

**Verification**:
```javascript
// OLD (WRONG):
side: side === 'YES' ? 'BUY' : 'SELL'

// NEW (CORRECT):
side: 'BUY'  // Always BUY the selected token
```

---

### 2. USDC Balance Display

**Symptom**: Balance shows `103291356` instead of `$103.29`

**Cause**: Polymarket API returns micro-units (6 decimals)

**Fix**:
- Location: `core/polymarketClient.js` lines 286-297, 256, 300-305
- Formula: `(rawBalance / 1e6).toFixed(2)`

**Verification**: Dashboard should show `BAL $103.29 USDC`

---

### 3. Order Precision (CLOB API Errors)

**Symptom**: "buy orders maker amount supports max 4 decimals, taker amount max 2 decimals"

**Cause**: Price and size not properly rounded

**Fix**:
- Location: `core/polymarketClient.js` lines 510-584
- **Price**: Rounded to 2-3 decimals based on tick size
- **Size**: `Math.floor(rawSize * 100) / 100` (floor to 2 decimals)
- **Min Size**: Rejects orders < 1 share

**Verification**: No more CLOB precision errors in logs

---

## 🟡 Medium Priority Fixes

### 4. JSON Parsing Failures

**Symptom**: "Sonnet JSON parse FAILED" in logs

**Cause**: Response truncation + insufficient extraction fallbacks

**Fix**:
- Location: `agents/baseAgent.js` lines 66-95, 462
- Increased `max_tokens`: 400 → 500
- Added line-by-line JSON extraction fallback

**Verification**: Parse failures should be rare/eliminated

---

### 5. Chart.js Resize Loop

**Symptom**: Dashboard chart constantly resizing (performance issue)

**Cause**: Responsive mode triggering infinite calculations

**Fix**:
- Location: `dashboard/public/index.html` lines 850-854, 1381-1421
- Set fixed dimensions: 280×120px
- Disabled responsive mode
- Only update on data change

**Verification**: Chart stable, no constant re-renders

---

## ✅ Enhancements

### 6. Sharp Traders UI Upgrade

**Added**:
- Rich card layout with rank badges
- Profile images and 𝕏 links
- Interactive bar chart (top 5 traders)
- Full metadata: `profileImage`, `xUsername`, `verifiedBadge`, `pnl`, `volume`
- New endpoint: `GET /api/leaderboard`

**Files**:
- `core/traderTracker.js`
- `dashboard/server.js`
- `dashboard/public/index.html`

---

### 7. Sports Metadata

**Added**:
- `fetchSportsMeta()` method in SportsAgent
- Resolution sources from `/sports` endpoint
- Context enrichment for sports market analysis

**File**: `agents/specializedAgents.js`

---

## Quick Test Checklist

After upgrading to v2.1:

- [ ] USDC balance displays correctly (dollars, not micro-units)
- [ ] Order logs show `side: 'BUY'` for both YES and NO trades
- [ ] Order logs show properly rounded `price` and `size`
- [ ] No CLOB API precision errors
- [ ] Sonnet JSON parsing succeeds consistently
- [ ] Dashboard chart stable (no resize loop)
- [ ] Sharp Traders panel shows rich cards and chart
- [ ] Leaderboard auto-populates from Polymarket API

---

## Rollback Instructions

If issues arise after upgrade:

1. **Emergency**: Revert to v2.0 tag
   ```bash
   git checkout v2.0
   npm install
   ```

2. **Partial rollback**: Cherry-pick specific fixes
   ```bash
   git revert <commit-hash>
   ```

3. **Database**: No schema changes, no rollback needed

---

## Support

- **Logs**: Check `logs/` directory for detailed traces
- **Docs**: See `CHANGELOG.md` for full details
- **Deploy**: See `DEPLOY.md` for Railway troubleshooting
- **API Docs**: `.github/copilot-instructions.md` (if available)

---

## Version Info

- **Version**: 2.1.0
- **Date**: 2026-03-25
- **Breaking Changes**: None
- **Migration Required**: No
- **Database Changes**: No

All fixes are backwards compatible and production-ready.
