# Polybot Documentation

This directory contains the primary design and requirements documents for Polybot.

- **`Polybot_PRD.pdf`** — Product Requirements Document. Covers agent functions, data flows, user stories, and feature requirements for the autonomous trading engine.
- **`Polybot_System_Design.pdf`** — Technical architecture and system design specification. Includes API sequence diagrams for Polymarket CLOB, Gamma API, and the two-model Claude pipeline.

For setup, configuration, and full architecture documentation see the main [`README.md`](../README.md).

---

## What Has Changed Since the PDFs Were Written

The PDFs describe the original v1.0 design. The current codebase reflects several significant additions and fixes:

### v2.2 Gemini-First Pipeline (March 2026)

**Major Architectural Change: 92% Cost Reduction**

The AI decision pipeline has been completely restructured to use Gemini as the primary judge instead of Claude Sonnet:

**Old Pipeline (v2.1 and earlier):**
- Haiku Scout → **Sonnet Judge** (100% of markets) → Gemini Validator
- Cost: ~$45/month

**New Pipeline (v2.2):**
- Haiku Scout → **Gemini Judge** (100% of markets, PRIMARY) → **Sonnet Arbiter** (5% of markets, SELECTIVE) → Gemini Validator
- Cost: ~$6.75/month (92% reduction)

**How It Works:**
1. Gemini 2.5 Flash analyzes all markets with live web search
2. Sonnet runs ONLY on exceptional trades: edge ≥10%, confidence ≥70%, liquidity ≥$200k
3. When both run and agree: confidence +10, marked as `dualConfirmed`
4. When both run and disagree: Gemini's decision is used with confidence -10

**Files Modified:**
- `core/geminiJudge.js` — Enhanced with comprehensive prompt and sharp signals
- `agents/baseAgent.js` — Rewrote scan() loop for Gemini-first logic
- `core/riskManager.js` — Lowered thresholds (minEdge: 5→4, minConf: 62→55)
- `core/stateStore.js` — Added sessionCost tracking
- `dashboard/public/index.html` — Added "Est. API Cost" metric

See [`docs/gemini-first-migration.md`](./gemini-first-migration.md) for complete migration guide.

### v2.1 Critical Fixes (March 2026)

**Order Placement Bug Fix**
- Fixed critical issue where NO trades incorrectly used SELL instead of BUY
- All new trades now properly BUY the correct token (YES=index 0, NO=index 1)
- Impact: Ensures positions match agent intent

**USDC Balance Conversion**
- Fixed display of balance from micro-units (6 decimals) to dollars
- Example: `103291356` now correctly displays as `$103.29`

**Order Precision**
- Added CLOB API-compliant decimal rounding (price: 2-3 decimals, size: 2 decimals)
- Minimum order size validation (1 share)
- Eliminates "maker amount supports max 4 decimals" errors

**JSON Parsing Robustness**
- Increased Sonnet max_tokens from 400 to 500
- Enhanced extraction with line-by-line fallback for truncated responses

**Sharp Traders UI**
- Rich card layout with rank badges, profile images, PnL/volume stats
- Interactive leaderboard bar chart (top 5 traders)
- Full metadata from Polymarket API (profileImage, xUsername, verifiedBadge)
- New `/api/leaderboard` endpoint

**Sports Metadata**
- SportsAgent now fetches resolution sources from `/sports` endpoint
- Enriches analysis with official ordering and resolution data

See [`CHANGELOG.md`](../CHANGELOG.md) for detailed fixes and migration notes.

### Gemini Validator (third model)

Every trade approved by Claude Sonnet now passes through a Gemini validation step before execution. Gemini uses Google Search grounding to search the live web and independently verify whether Claude's edge estimate holds against current information.

- CONFIRM → trade executes
- VETO → trade is cancelled, decision logged to Supabase

Configuration: `GEMINI_API_KEY` and `GEMINI_MODEL` in `.env`. Disabled gracefully if no key is set.

### Supabase Persistence Layer

All agent decisions (scout verdicts, judge analysis, Gemini validation) and executed trades are written to a Supabase Postgres database in real time. This enables:

- Session continuity across restarts (trades and daily stats reload on boot)
- Market data caching between restarts (configurable TTL, default 10 minutes)
- News context caching (5 minutes, protects GNews 100/day budget)
- Real-time dashboard updates via Postgres change subscriptions

Tables: `trades`, `agent_decisions`, `market_cache`, `daily_stats`, `news_cache`

See the main README for the SQL schema and setup instructions.

### Polygon RPC Removed

The original design included a fallback Polygon RPC stack for USDC balance queries. This has been removed. Balance is now fetched exclusively via the CLOB API (`getBalanceAllowance`), which requires no blockchain access.

### USDC Contract Constants Removed

`USDC_CONTRACT` and `POLYGON_RPC_URL` environment variables are no longer used and have been removed from `.env.example`.
