# Changelog

All notable changes to Polybot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.0] - 2026-03-25

### Fixed

#### Critical Order Placement Bug
- **Issue**: When agent decided to bet "NO", bot was incorrectly using `SELL` on YES token instead of `BUY` on NO token
- **Impact**: NO trades were being placed incorrectly, potentially resulting in opposite positions
- **Fix**: All new trades now correctly use `BUY` side with proper token selection:
  - YES decision → BUY token at index 0 (YES token)
  - NO decision → BUY token at index 1 (NO token)
- **Files**: `agents/baseAgent.js` (line 711)

#### USDC Balance Display
- **Issue**: Polymarket API returns balance in micro-units (6 decimals), causing incorrect display
- **Example**: Balance of `103291356` displayed as-is instead of `$103.29`
- **Fix**: Added proper conversion `(rawBalance / 1e6).toFixed(2)` in three locations:
  - `getUSDCBalance()` method
  - `init()` balance verification
  - `refreshWallet()` method
- **Files**: `core/polymarketClient.js` (lines 286-297, 256, 300-305)

#### Order Precision (CLOB API Compliance)
- **Issue**: Polymarket CLOB API rejected orders with error: "buy orders maker amount supports max 4 decimals, taker amount max 2 decimals"
- **Root Cause**: Price and size not properly rounded to API precision requirements
- **Fix**: Implemented proper rounding in `placeOrder()`:
  - **Price**: Rounded to 2-3 decimals based on tick size
  - **Size**: Floor to 2 decimals using `Math.floor(rawSize * 100) / 100`
  - **Validation**: Added minimum order size check (1 share minimum)
- **Files**: `core/polymarketClient.js` (lines 510-584)

#### JSON Parsing Failures
- **Issue**: Claude Sonnet responses getting truncated, causing parse failures
- **Fix 1**: Increased `max_tokens` from 400 to 500 to prevent truncation
- **Fix 2**: Enhanced `extractJSON()` function with line-by-line fallback:
  - Step 1: Strip markdown fences
  - Step 2: Direct parse attempt
  - Step 3: Find first `{...}` block
  - Step 4: Find first `[...]` block
  - Step 5: **NEW** - Try each line starting with `{`
- **Files**: `agents/baseAgent.js` (lines 66-95, 462)

#### Chart.js Resize Loop
- **Issue**: Leaderboard chart constantly resizing/looping, causing performance degradation
- **Root Cause**: Chart.js responsive mode triggering infinite resize calculations
- **Fix**: Three-part solution:
  1. Set fixed canvas dimensions (280×120px)
  2. Disabled responsive mode: `responsive: false`
  3. Only update chart when data changes (compare labels before update)
  4. Use `update('none')` to skip animation on updates
- **Files**: `dashboard/public/index.html` (lines 850-854, 1381-1421)

### Added

#### Sharp Traders Enhanced UI
- Rich card layout with rank badges, profile images, and stats
- Interactive bar chart showing top 5 traders by PnL
- Auto-discovery from Polymarket leaderboard API
- Trader metadata: `profileImage`, `xUsername`, `verifiedBadge`, `rank`, `pnl`, `volume`
- New endpoint: `GET /api/leaderboard` for programmatic access
- **Files**: 
  - `core/traderTracker.js` (lines 59-83, 202-221)
  - `dashboard/server.js` (lines 83-91)
  - `dashboard/public/index.html` (lines 842-866, 1317-1422)

#### Sports Metadata Integration
- Added `fetchSportsMeta()` method to SportsAgent
- Pulls resolution sources and ordering info from `/sports` endpoint
- Enriches market analysis with official metadata
- **Files**: `agents/specializedAgents.js` (SportsAgent class)

### Changed

#### Model Configuration
- Sonnet judge now uses 500 max_tokens (up from 400) to prevent truncation
- Better handling of incomplete JSON responses

#### Code Quality
- Added comprehensive inline comments for critical order logic
- Improved error messages with specific values vs thresholds
- Enhanced logging for order placement (tokenId, price, size, stake, tickSize)

---

## [2.0.0] - Previous Release

### Added
- Three-model AI pipeline (Haiku scout → Gemini judge → Sonnet arbiter)
- Gemini validator with live web search
- Six specialized agents (Crypto, Politics, Economics, Sports, Weather, Odds)
- Supabase persistence layer
- Real-time dashboard with WebSocket updates
- Sharp trader tracking with leaderboard integration
- Railway deployment configuration
- Health check endpoint

### Changed
- Aggressive judge prompts for more decisive trading
- Lowered thresholds in simulation mode
- Single-port architecture for Railway compatibility

### Fixed
- Supabase RLS detection with boot-time write tests
- GNews budget protection (30-min cache)
- Dashboard halt state recovery

---

## Key Files Reference

### Critical Trading Logic
- `agents/baseAgent.js` - Agent pipeline and trade execution
- `core/polymarketClient.js` - Order placement and wallet management
- `core/riskManager.js` - Kelly sizing and approval gate

### Data & Persistence
- `core/traderTracker.js` - Leaderboard tracking and signal generation
- `core/persistence.js` - Supabase database operations
- `core/stateStore.js` - In-memory state management

### Dashboard
- `dashboard/server.js` - Express HTTP + WebSocket server
- `dashboard/public/index.html` - Real-time monitoring UI

### Configuration
- `.env.example` - Environment variables template
- `railway.json` - Railway deployment config
- `DEPLOY.md` - Deployment guide

---

## Migration Notes

### Upgrading from v2.0 to v2.1

1. **No breaking changes** - all fixes are backwards compatible
2. **Recommended**: Review existing open positions placed before the order placement fix
3. **Optional**: Clear browser cache to get updated dashboard UI
4. **Database**: No schema changes required

### Testing After Upgrade

1. Check USDC balance displays correctly in dashboard
2. Verify order placement logs show proper token selection (YES=index 0, NO=index 1)
3. Monitor for CLOB API precision errors (should be eliminated)
4. Confirm Sharp Traders panel shows leaderboard chart and rich cards

---

## Bug Reports

If you encounter issues:

1. Check logs in `logs/` directory for detailed error traces
2. Verify environment variables in `.env` match `.env.example`
3. Test Supabase write access: look for "Supabase write test: PASSED ✓" in boot logs
4. Review order placement logs for precision/rounding errors

For deployment issues, see `DEPLOY.md` for Railway-specific troubleshooting.
