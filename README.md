# Polybot v2.2

**Autonomous Polymarket Trading Engine**

Polybot is a fully autonomous algorithmic trading system for [Polymarket](https://polymarket.com/). It runs a four-stage AI pipeline across seven specialized agents, validates every trade against live web data, queues all Gemini calls through a global rate-limit-safe queue, persists decisions to Supabase, and streams real-time state to a professional monitoring dashboard with per-agent start/stop controls.

---

## Table of Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Supabase Setup](#supabase-setup-optional)
- [Running](#running)
- [Configuration Reference](#configuration-reference)
- [Boot Sequence](#boot-sequence)
- [Risk Controls](#risk-controls)
- [News Sources](#news-sources)
- [Project Structure](#project-structure)
- [Documentation Index](#documentation-index)
- [Recent Updates](#recent-updates)
- [Disclaimer](#disclaimer)

---

## Architecture

### Four-Stage AI Pipeline (Gemini-First)

Every potential trade passes through a cost-optimized four-layer AI pipeline:

| Stage | Model | Role | Cost | Frequency |
|-------|-------|------|------|-----------|
| Scout | Claude Haiku (with Gemini fallback) | Fast first-pass filter — evaluates market quality, rejects noise | ~$0.001/market | 100% of markets |
| Judge | Gemini 2.5 Flash | **PRIMARY** deep mispricing analysis with live web search | ~$0.0005/market | 100% of markets |
| Arbiter | Claude Sonnet | **SELECTIVE** second opinion only for exceptional trades (edge ≥10%, conf ≥70%, liq ≥$200k) | ~$0.015/market | ~5% of markets |
| Validator | Gemini 2.5 Flash | Final veto power using live web search | per call | Approved trades only |

**Pipeline Logic:**
1. **Haiku Scout** filters out low-quality markets (auto-falls back to Gemini if Anthropic credits exhausted)
2. **Gemini Judge** analyzes all approved markets with live web search (primary analyst)
3. **Sonnet Arbiter** runs ONLY when Gemini finds exceptional edge on high-liquidity markets
4. **Gemini Validator** performs final veto check before execution

When both Gemini and Sonnet run and agree, confidence is boosted +10% (`dualConfirmed`). If they disagree, Gemini's decision is used with reduced confidence.

**Cost Savings:** This Gemini-first approach reduces API costs by ~92% compared to Sonnet-first:
- **Old (Sonnet primary):** ~$45/month
- **New (Gemini primary):** ~$3.75–6.75/month

### Global AI Request Queue

All Gemini API calls are routed through a **global rate-limit queue** (`core/aiQueue.js`) that prevents rate limit blackouts:

| Parameter | Value | Effect |
|-----------|-------|--------|
| Max Concurrent | 10 | Up to 10 simultaneous Gemini calls |
| Min Delay | 300ms | ~200 calls/min max throughput |
| Priority | High/Normal | Validators get priority over scouts |
| Hard Cap | 3 markets/agent/scan | Prevents burst overload |

The queue tracks statistics (calls, errors, queue depth, wait times) visible on the dashboard.

### Supervisor

An AI-powered **Supervisor** (`core/supervisor.js`) runs periodic 20-minute health reviews:

- Reviews recent win rate, P&L, losing streaks, balance
- Uses Gemini to make high-level CONTINUE/PAUSE decisions
- Adjusts risk multiplier (INCREASE/DECREASE/KEEP)
- Max 20 calls/day (very low cost)
- Triggers immediately on 3+ losing streak or daily P&L < -$10

### Seven Specialized Agents

Each agent runs on its own scan interval, filtering markets by domain:

| Agent | Interval | Domain | Markets/Scan | Notes |
|-------|----------|--------|-------------|-------|
| CryptoAgent | 120s | BTC, ETH, DeFi, crypto regulation | 20 | General crypto markets |
| PoliticsAgent | 150s | Elections, legislation, executive actions | 20 | |
| EconomicsAgent | 180s | Fed, CPI, GDP, S&P, macro data | 20 | |
| SportsAgent | 120s | NFL, NBA, MLB, UFC, tournaments | 20 | Includes resolution source metadata |
| WeatherAgent | 240s | Hurricanes, tornadoes, extreme weather | 15 | |
| OddsAgent | 150s | High-volume general markets | 25 | |
| **BTCFastAgent** | **60s** | **BTC 5-minute Up/Down markets** | **1** | **High-frequency, Gemini-only, $3 max stake** |

> **Note:** Only BTCFastAgent auto-starts at boot. All other agents start in **stopped** state and can be activated via the dashboard toggle buttons.

#### BTCFastAgent

A specialized high-frequency trader that:
- Targets live "BTC 5 Minute Up or Down" markets on Polymarket
- Uses real-time BTC price from `stateStore` (populated by newsFetcher), with CryptoCompare and CoinCap fallbacks
- **Momentum-based strategy** using rolling 5-price history — no AI calls needed
- Small stakes ($3 max per trade) with 5-minute cooldown between trades
- **Take-profit monitoring** — checks open positions every 60s, alerts at 40%+ gain
- Smart market finding with text search fallbacks ("5 min", "5-min", "5min", "five min")

#### Dashboard Agent Controls

Every agent card on the dashboard includes a **Start/Stop toggle button**:
- Click **Stop** → agent stops scanning, dot turns gray
- Click **Start** → agent resumes scanning, no bot restart needed
- State updates instantly via WebSocket

### Persistence Layer (Supabase)

All decisions and trades are written to Supabase in real time:

| Table | Purpose |
|-------|---------|
| `trades` | Full trade record with P&L tracking |
| `agent_decisions` | Every scout, judge, arbiter, and validator decision |
| `market_cache` | Market data cached between restarts (configurable TTL) |
| `daily_stats` | Session stats synced every 60 seconds |
| `news_cache` | News context cached 30 minutes to protect GNews 100/day budget |

The system runs fully without Supabase (graceful fallback). Supabase adds persistence across restarts and real-time dashboard updates via Postgres change subscriptions.

### Sharp Trader Tracking

The **TraderTracker** (`core/traderTracker.js`) monitors top Polymarket traders:

- Auto-discovers top 10 from Polymarket weekly leaderboard API
- Fetches positions and recent trades for each watched wallet every 5 minutes
- Generates "SHARP TRADER ACTIVITY" signal block injected into AI prompts
- Rich dashboard panel with rank badges, profile images, X/Twitter links, PnL/volume stats
- Interactive bar chart showing top 5 traders
- API endpoint: `GET /api/leaderboard`

---

## Prerequisites

- **Node.js** v20.x (see `.nvmrc`)
- **Polymarket account** with funder address and exported private key
- **Gemini API key** (required — powers the primary judge, validator, and supervisor)
- Anthropic API key (optional — enables Haiku scout + Sonnet arbiter; system runs 100% on Gemini without it)
- GNews API key (optional — 100 req/day free tier)
- TinyFish API key (optional — premium news enrichment)
- Supabase project (optional — adds persistence and real-time dashboard)

---

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/polybot.git
cd polybot
npm install
cp .env.example .env
```

Edit `.env` with your credentials. The minimum required to run:

```
GEMINI_API_KEY=your_gemini_api_key
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
```

All other keys (Anthropic, GNews, TinyFish, Supabase) are optional. The system runs in READ-ONLY simulation mode with no private key set.

---

## Supabase Setup (Optional)

1. Create a free project at [supabase.com](https://supabase.com)
2. Go to **Settings → API** and copy your project URL and anon key
3. Add to `.env`:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your_anon_key
   ```
4. Start the bot — if tables are missing, the boot log will print the full SQL schema to run
5. Copy that SQL into **Supabase → SQL Editor** and run it
6. **Disable RLS** (Row Level Security) on all 5 tables, or add permissive policies:
   ```sql
   CREATE POLICY "allow_all" ON trades           FOR ALL USING (true) WITH CHECK (true);
   CREATE POLICY "allow_all" ON agent_decisions  FOR ALL USING (true) WITH CHECK (true);
   CREATE POLICY "allow_all" ON market_cache     FOR ALL USING (true) WITH CHECK (true);
   CREATE POLICY "allow_all" ON news_cache       FOR ALL USING (true) WITH CHECK (true);
   CREATE POLICY "allow_all" ON daily_stats      FOR ALL USING (true) WITH CHECK (true);
   ```
7. Restart — you should see `Supabase write test: PASSED ✓`

---

## Running

### Quick Start

```bash
# Direct (simple)
npm start

# Development (auto-restart on file changes)
npm run dev
```

### Production Hosting (PM2 + Ngrok)

For production-grade local hosting with auto-restart and a public URL:

#### 1. Start with PM2 (process manager)

```bash
# Start bot via PM2 with auto-restart
npm run pm2

# Or use the all-in-one script (PM2 + health check + tunnel)
npm run tunnel
```

PM2 provides:
- **Auto-restart** on crash (exponential backoff)
- **Memory limit** — restarts if exceeding 512MB
- **Structured logging** → `logs/pm2-out.log`, `logs/pm2-error.log`
- **Process monitoring** — `pm2 monit` for real-time CPU/memory

#### 2. Expose Public URL (Ngrok)

```bash
# One-time setup: get free token from https://dashboard.ngrok.com/signup
ngrok config add-authtoken YOUR_AUTH_TOKEN

# Start tunnel
ngrok http 3000
```

This gives you a public HTTPS URL like `https://abc123.ngrok-free.app` with:
- **Dashboard**: `https://abc123.ngrok-free.app`
- **Health Check**: `https://abc123.ngrok-free.app/health`
- **WebSocket**: `wss://abc123.ngrok-free.app/ws`
- **State API**: `https://abc123.ngrok-free.app/api/state`
- **Webhook Endpoint**: `https://abc123.ngrok-free.app/api/trade/manual`

#### PM2 Management Commands

```bash
npm run pm2              # Start bot via PM2
npm run pm2:stop         # Stop and remove from PM2
npm run pm2:logs         # View live logs
npm run pm2:monit        # Real-time monitoring dashboard

pm2 restart polybot      # Restart the bot
pm2 status               # Check process status
pm2 flush polybot        # Clear log files
```

#### All-in-One Script

```bash
node start.js              # PM2 + health check + ngrok tunnel
node start.js --no-tunnel  # PM2 only (no public URL)
node start.js --stop       # Stop everything
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI |
| `/health` | GET | Health check (status, uptime, engine state) |
| `/ws` | WS | WebSocket real-time updates |
| `/api/state` | GET | Full system snapshot |
| `/api/leaderboard` | GET | Sharp trader leaderboard data |
| `/api/traders` | GET | Trader tracker summary |
| `/api/config` | GET | Public Supabase config |
| `/api/engine/start` | POST | Start trading engine |
| `/api/engine/stop` | POST | Stop trading engine |
| `/api/risk/reset-daily` | POST | Reset daily P&L, resume if halted |
| `/api/trade/manual` | POST | Submit manual trade for analysis |
| `/api/agents/:name/toggle` | POST | Start/stop individual agent |
| `/api/traders/add` | POST | Add wallet to watch list |
| `/api/supervisor/check` | POST | Force supervisor health check |

### Railway Deployment

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for a comprehensive Railway deployment guide including:
- Environment variable setup
- Single-port architecture (HTTP + WebSocket on same port)
- Supabase RLS troubleshooting
- Monthly cost estimates (~$15–35/month all-in)

---


## Configuration Reference

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `POLYMARKET_PRIVATE_KEY` | — | Wallet private key. Omit for READ-ONLY mode |
| `POLYMARKET_FUNDER_ADDRESS` | — | Polymarket proxy wallet address |
| `POLYMARKET_SIGNATURE_TYPE` | `1` | `1` = POLY_PROXY (email/Magic login), `0` = raw EOA |

### Models

| Variable | Default | Description |
|----------|---------|-------------|
| `SCOUT_MODEL` | `claude-haiku-4-5-20251001` | Fast scout model (auto-falls back to Gemini if credits exhausted) |
| `JUDGE_MODEL` | `claude-sonnet-4-6` | Selective arbiter model (runs only on exceptional trades) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Primary judge + validator. Use `gemini-2.5-pro` for deeper reasoning |
| `GEMINI_API_KEY` | — | Gemini API key (**recommended** — powers the primary pipeline) |
| `ANTHROPIC_API_KEY` | — | Claude API key (optional — enables Haiku scout + Sonnet arbiter) |

### Risk Management

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_STAKE_USD` | `20` | Maximum stake per trade |
| `MIN_STAKE_USD` | `1` | Minimum stake per trade |
| `DAILY_LOSS_LIMIT_USD` | `50` | Daily loss limit — engine halts on breach |
| `MAX_OPEN_TRADES` | `8` | Maximum concurrent open positions |
| `MIN_EDGE_PCT` | `5` | Minimum required edge to execute (lowered to 4 internally for Gemini) |
| `MIN_CONFIDENCE_PCT` | `62` | Minimum required confidence to execute (lowered to 55 internally for Gemini) |

### Agent Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `SCAN_INTERVAL_SECONDS` | `45` | Base scan interval (agents override with their own intervals) |

### News

| Variable | Default | Description |
|----------|---------|-------------|
| `GNEWS_API_KEY` | — | GNews API key. 100 req/day free tier, hard stop at 95 |
| `TINYFISH_API_KEY` | — | TinyFish premium news enrichment. Auto-disables on auth failure |

### Supabase

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_ANON_KEY` | — | Supabase anon/public key |
| `MARKET_CACHE_TTL_MINUTES` | `10` | How long to serve market data from cache |

### Polymarket API

| Variable | Default | Description |
|----------|---------|-------------|
| `GAMMA_API_URL` | `https://gamma-api.polymarket.com` | Polymarket Gamma API (market data) |
| `CLOB_API_URL` | `https://clob.polymarket.com` | Polymarket CLOB API (order placement) |

---

## Boot Sequence

```
 1. Init Polymarket wallet (geoblock check, API creds, heartbeat)
 2. Test Gamma API connectivity
 3. Init Gemini validator + Gemini judge
 4. Connect to Supabase + boot write test + restore session state
 5. Start dashboard (HTTP + WebSocket on single port)
 6. Register all agents (only BTCFastAgent auto-starts)
 7. Init TraderTracker (leaderboard auto-discovery)
 8. Start Supervisor (20-min periodic health reviews)
 9. Start Data API polling (on-chain positions/P&L every 30s)
10. Start daily stats sync to Supabase (every 60s)
11. Schedule midnight UTC daily P&L reset
12. Start engine watchdog (auto-restart on API failure every 2 min)
```

---

## Risk Controls

Seven conditions must all pass before a trade executes:

1. Engine not halted (supervisor has not issued PAUSE)
2. Daily P&L has not breached `DAILY_LOSS_LIMIT_USD` (auto-halt on breach)
3. Open trade count below `MAX_OPEN_TRADES`
4. AI decision is not SKIP
5. `|edge|` >= `MIN_EDGE_PCT`
6. Confidence >= `MIN_CONFIDENCE_PCT`
7. HIGH risk trades require `|edge|` >= 10%

After passing all seven, Gemini validates against live web data. A VETO at this stage cancels the trade.

### Stake Sizing

Uses a fractional Kelly formula:
```
stake = (maxStake × 10) × (|edge| / 100) × (confidence / 100) × 0.25 × riskModifier
```
Where `riskModifier` is `1.0` (LOW), `0.7` (MEDIUM), or `0.4` (HIGH), clamped to `[MIN_STAKE, MAX_STAKE]`.

The Supervisor can dynamically adjust the risk modifier (+25% on INCREASE, −50% on DECREASE).

---

## News Sources

**Layer 1 — TinyFish** (premium, optional): Real-time web scraping and search. Auto-disables on auth failure, 5-min cooldown after 3 errors, 10-min cooldown on rate limit.

**Layer 2 — Free APIs** (always available):
- GNews: Headlines and targeted search, 100 req/day budget with hard stop at 95
- CryptoCompare: Crypto news and sentiment
- CoinGecko: Crypto prices and 24h change
- Open-Meteo: Weather forecasts

**Layer 3 — Gemini Live Search** (built-in): The Gemini Judge uses Google Search tool grounding to fetch real-time web data during market analysis — no separate API required.

News context is cached 30 minutes in Supabase (if configured) to minimize API calls.

---

## Project Structure

```
prediction-market/
├── index.js                    # Boot sequence and agent orchestration
├── core/
│   ├── aiQueue.js              # Global Gemini rate-limit queue (10 concurrent, 300ms spacing)
│   ├── db.js                   # Supabase client and table bootstrap
│   ├── geminiJudge.js          # Gemini primary judge with web search
│   ├── geminiValidator.js      # Gemini live-search trade validator
│   ├── logger.js               # Winston rotating file logger
│   ├── newsFetcher.js          # Multi-source news aggregation (TinyFish → free APIs)
│   ├── persistence.js          # All Supabase database operations
│   ├── polymarketClient.js     # Polymarket CLOB and Gamma API client
│   ├── riskManager.js          # Kelly sizing, approval gate, risk controls
│   ├── stateStore.js           # In-memory state with EventEmitter + API cost tracking
│   ├── supervisor.js           # AI system health monitor (20-min reviews)
│   └── traderTracker.js        # Sharp trader leaderboard tracking
├── agents/
│   ├── baseAgent.js            # Four-stage pipeline + Gemini-first logic
│   ├── btcFastAgent.js         # BTC 5-minute momentum trader
│   └── specializedAgents.js    # Six domain agents (Crypto, Politics, Economics, Sports, Weather, Odds)
├── dashboard/
│   ├── server.js               # Express + WebSocket server + agent toggle API
│   └── public/index.html       # Real-time monitoring dashboard with agent controls
├── docs/
│   ├── AGENT_CONTROLS_AND_BTC_REWRITE.md  # Agent toggle + BTCFastAgent rewrite docs
│   ├── BTC_TAKE_PROFIT.md                 # Take-profit monitoring implementation
│   ├── CHANGELOG.md                       # Full version history (v2.0 → v2.2)
│   ├── DEPLOY.md                          # Railway deployment guide
│   ├── FIXES.md                           # v2.1 bug fix summary
│   ├── gemini-first-migration.md          # Gemini-first pipeline migration guide
│   ├── RATE_LIMIT_FIX.md                  # AI queue rate limit fix docs
│   ├── README.md                          # Docs index + what changed since PDFs
│   ├── Polybot_PRD.pdf                    # Product Requirements Document
│   └── Polybot_System_Design.pdf          # System architecture design
├── data/                       # Runtime data files
├── logs/                       # Winston + PM2 log files (rotated daily)
├── .env.example                # Environment variables template
├── .nvmrc                      # Node.js version (20)
├── ecosystem.config.js         # PM2 process manager configuration
├── start.js                    # All-in-one startup script (PM2 + ngrok)
├── railway.json                # Railway deployment configuration
├── .railwayignore              # Railway build exclusions
├── fix-allowance.js            # USDC allowance fix utility
├── test-auth.js                # Polymarket auth test script
└── test-price.js               # BTC price test script
```

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Full version history with detailed changes (v2.0 → v2.1 → v2.2) |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Railway deployment guide, Supabase RLS setup, cost estimates |
| [`docs/FIXES.md`](docs/FIXES.md) | v2.1 critical bug fix summary with quick test checklist |
| [`docs/gemini-first-migration.md`](docs/gemini-first-migration.md) | Gemini-first pipeline migration guide, expected behavior, FAQ |
| [`docs/RATE_LIMIT_FIX.md`](docs/RATE_LIMIT_FIX.md) | AI queue implementation, call volume calculations, monitoring |
| [`docs/AGENT_CONTROLS_AND_BTC_REWRITE.md`](docs/AGENT_CONTROLS_AND_BTC_REWRITE.md) | Dashboard agent toggle controls + BTCFastAgent rewrite details |
| [`docs/BTC_TAKE_PROFIT.md`](docs/BTC_TAKE_PROFIT.md) | Take-profit monitoring implementation for BTC fast trades |
| [`docs/README.md`](docs/README.md) | Docs index — what changed since the original PDF designs |
| [`docs/Polybot_PRD.pdf`](docs/Polybot_PRD.pdf) | Original Product Requirements Document |
| [`docs/Polybot_System_Design.pdf`](docs/Polybot_System_Design.pdf) | Original system architecture design |

---

## Recent Updates

### v2.2 — Gemini-First Pipeline + BTCFastAgent + Agent Controls

#### 1. Gemini-First Pipeline (92% Cost Reduction)
- **Gemini is now the primary judge** — analyzes 100% of markets with live web search
- **Sonnet demoted to selective arbiter** — runs only on exceptional trades (edge ≥10%, conf ≥70%, liq ≥$200k)
- **Dual confirmation** — when both models agree, confidence +10; when they disagree, Gemini wins with confidence −10
- **Cost tracking** — dashboard shows estimated API cost per session
- See full migration guide: [`docs/gemini-first-migration.md`](docs/gemini-first-migration.md)

#### 2. BTCFastAgent (High-Frequency BTC Trader)
- New specialized agent for BTC 5-minute Up/Down markets
- Momentum-based strategy using rolling price history (no AI calls)
- $3 max stake, 5-minute cooldown between trades
- Take-profit monitoring with 40%+ gain alerts
- See details: [`docs/AGENT_CONTROLS_AND_BTC_REWRITE.md`](docs/AGENT_CONTROLS_AND_BTC_REWRITE.md)

#### 3. Dashboard Agent Controls
- **Start/Stop buttons** on every agent card — no bot restart needed
- Toggle endpoint: `POST /api/agents/:name/toggle`
- Visual state: green dot + red "Stop" button (active) / gray dot + green "Start" button (inactive)

#### 4. Global AI Rate Limit Queue
- All Gemini calls routed through priority queue (10 concurrent, 300ms spacing)
- Hard cap of 3 markets per agent per scan
- Agent intervals increased 2–3x to reduce API pressure
- Dashboard shows queue stats: depth, running, calls today, error rate
- See details: [`docs/RATE_LIMIT_FIX.md`](docs/RATE_LIMIT_FIX.md)

#### 5. Gemini Scout Fallback (Zero-Downtime)
- When Anthropic credits are exhausted, scouts automatically switch to Gemini
- Seamless transition — bot continues running 100% on Gemini with no interruption
- ~50% cheaper than Haiku scouts

#### 6. Supervisor (AI Health Monitor)
- 20-minute periodic system health reviews using Gemini
- Can PAUSE system or adjust risk levels based on win rate, P&L, streaks
- Max 20 calls/day, triggers immediately on 3+ losing streak

### v2.1 — Critical Bug Fixes

#### 7. Order Placement Bug (HIGH SEVERITY)
- Fixed critical issue where NO trades incorrectly used SELL instead of BUY
- All trades now correctly BUY the appropriate token (YES=index 0, NO=index 1)

#### 8. USDC Balance Display
- Fixed conversion from micro-units (6 decimals) to dollars
- Balance now correctly displays as `$103.29` instead of `103291356`

#### 9. Order Precision (CLOB API Compliance)
- Price rounded to 2–3 decimals based on tick size
- Size (shares) rounded down to 2 decimals (floor)
- Minimum order size validation (1 share minimum)

#### 10. JSON Parsing Robustness
- Enhanced `extractJSON()` with line-by-line fallback
- Increased Sonnet `max_tokens` from 400 to 500

#### 11. Sharp Traders Enhanced UI
- Rich card layout with rank badges, profile images, PnL/volume stats
- Interactive leaderboard bar chart (top 5 traders)
- Auto-discovery from Polymarket API with full trader metadata
- New endpoint: `GET /api/leaderboard`

#### 12. Sports Metadata Integration
- `fetchSportsMeta()` pulls resolution sources from Polymarket `/sports` endpoint
- Enriches sports market analysis with official metadata

### v2.0 — Foundation

- Three-model AI pipeline (Haiku scout → Sonnet judge → Gemini validator)
- Six specialized domain agents
- Supabase persistence layer with real-time subscriptions
- Professional monitoring dashboard with WebSocket updates
- Sharp trader tracking with leaderboard integration
- Railway deployment configuration with single-port architecture
- Engine watchdog, RLS detection, GNews budget protection

---

## Disclaimer

This software is provided for educational and experimental purposes. Prediction market trading involves substantial risk of loss. The authors are not responsible for any financial losses incurred while using this system. Always test in READ-ONLY simulation mode before deploying with real funds.
