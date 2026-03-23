# Polybot v2.0

**Autonomous Polymarket Trading Engine**

Polybot is a fully autonomous algorithmic trading system for [Polymarket](https://polymarket.com/). It runs a three-model AI pipeline across six specialized agents, validates every trade against live web data, persists all decisions to Supabase, and streams real-time state to a professional monitoring dashboard.

---

## Architecture

### Three-Model AI Pipeline

Every potential trade passes through three independent models before execution:

| Stage | Model | Role | Cost |
|-------|-------|------|------|
| Scout | Claude Haiku | Fast first-pass filter — evaluates market quality, rejects noise | ~$0.001/market |
| Judge | Claude Sonnet | Deep mispricing analysis with full news context | ~$0.015/market |
| Validator | Gemini 2.5 Flash | Live web search + independent validation of Claude's reasoning | per call |

A trade only executes if all three models agree. Gemini can veto a Sonnet-approved trade if live web search contradicts Claude's reasoning.

### Six Specialized Agents

Each agent runs on its own scan interval, filtering markets by domain:

| Agent | Interval | Domain |
|-------|----------|--------|
| CryptoAgent | 40s | BTC, ETH, DeFi, crypto regulation |
| PoliticsAgent | 60s | Elections, legislation, executive actions |
| EconomicsAgent | 75s | Fed, CPI, GDP, S&P, macro data |
| SportsAgent | 50s | NFL, NBA, MLB, UFC, tournaments |
| WeatherAgent | 90s | Hurricanes, tornadoes, extreme weather |
| OddsAgent | 55s | High-volume general markets |

### Persistence Layer (Supabase)

All decisions and trades are written to Supabase in real time:

- **`agent_decisions`** — every scout, judge, and Gemini decision for every market evaluated
- **`trades`** — full trade record with P&L tracking
- **`market_cache`** — market data cached between restarts (configurable TTL)
- **`daily_stats`** — session stats synced every 60 seconds
- **`news_cache`** — news context cached 5 minutes to protect GNews 100/day budget

The system runs fully without Supabase (graceful fallback). Supabase adds persistence across restarts and real-time dashboard updates via Postgres change subscriptions.

---

## Prerequisites

- Node.js v18.0.0 or higher
- Polymarket account with funder address and exported private key
- Anthropic API key (Claude Haiku + Sonnet)
- Gemini API key (optional — enables live web search validation)
- GNews API key (optional — 100 req/day free tier)
- TinyFish API key (optional — premium news enrichment)
- Supabase project (optional — adds persistence and real-time dashboard)

---

## Installation

```bash
npm install
cp .env.example .env
```

Edit `.env` with your credentials. The minimum required to run:

```
ANTHROPIC_API_KEY=sk-ant-...
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
```

All other keys (Gemini, GNews, TinyFish, Supabase) are optional. The system runs in READ-ONLY simulation mode with no private key set.

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
6. Restart — you should see `Supabase: connected and tables verified`

---

## Running

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Dashboard: [http://localhost:3000](http://localhost:3000)
WebSocket: `ws://localhost:3001`

---

## Configuration Reference

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | required | Claude API key |
| `POLYMARKET_PRIVATE_KEY` | — | Wallet private key. Omit for READ-ONLY mode |
| `POLYMARKET_FUNDER_ADDRESS` | — | Polymarket proxy wallet address |
| `POLYMARKET_SIGNATURE_TYPE` | `1` | `1` = POLY_PROXY (email/Magic login), `0` = raw EOA |

### Models

| Variable | Default | Description |
|----------|---------|-------------|
| `SCOUT_MODEL` | `claude-haiku-4-5-20251001` | Fast scout model |
| `JUDGE_MODEL` | `claude-sonnet-4-6` | Deep analysis model |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Validator model. Use `gemini-2.5-pro` for deeper reasoning |
| `GEMINI_API_KEY` | — | Gemini API key. Omit to disable validation layer |

### Risk Management

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_STAKE_USD` | `20` | Maximum stake per trade |
| `MIN_STAKE_USD` | `1` | Minimum stake per trade |
| `DAILY_LOSS_LIMIT_USD` | `50` | Daily loss limit — engine halts on breach |
| `MAX_OPEN_TRADES` | `8` | Maximum concurrent open positions |
| `MIN_EDGE_PCT` | `5` | Minimum required edge to execute |
| `MIN_CONFIDENCE_PCT` | `62` | Minimum required confidence to execute |

### Supabase

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_ANON_KEY` | — | Supabase anon/public key |
| `MARKET_CACHE_TTL_MINUTES` | `10` | How long to serve market data from cache |

---

## Boot Sequence

```
1. Init Gemini validator
2. Init Polymarket wallet (geoblock check, API creds, heartbeat)
3. Connect to Supabase + restore session state from previous run
4. Start dashboard (HTTP :3000, WebSocket :3001)
5. Start 6 agents with 3s stagger
6. Start Data API polling (on-chain positions/P&L every 30s)
7. Start daily stats sync to Supabase (every 60s)
8. Schedule midnight UTC daily P&L reset
```

---

## Risk Controls

Seven conditions must all pass before a trade executes:

1. Engine not halted
2. Daily P&L has not breached `DAILY_LOSS_LIMIT_USD` (auto-halt on breach)
3. Open trade count below `MAX_OPEN_TRADES`
4. Claude decision is not SKIP
5. `|edge|` >= `MIN_EDGE_PCT`
6. Confidence >= `MIN_CONFIDENCE_PCT`
7. HIGH risk trades require `|edge|` >= 10%

After passing all seven, Gemini validates against live web data. A VETO at this stage cancels the trade.

Stake sizing uses a fractional Kelly formula:
```
stake = (maxStake × 10) × (|edge| / 100) × (confidence / 100) × 0.25 × riskModifier
```
Where `riskModifier` is `1.0` (LOW), `0.7` (MEDIUM), or `0.4` (HIGH), clamped to `[MIN_STAKE, MAX_STAKE]`.

---

## News Sources

**Layer 1 — TinyFish** (premium, optional): Real-time web scraping and search. Auto-disables on auth failure, 5-min cooldown after 3 errors, 10-min cooldown on rate limit.

**Layer 2 — Free APIs** (always available):
- GNews: Headlines and targeted search, 100 req/day budget with hard stop at 95
- CryptoCompare: Crypto news and sentiment
- CoinGecko: Crypto prices and 24h change
- Open-Meteo: Weather forecasts

News context is cached 5 minutes in memory and in Supabase (if configured) to minimize API calls.

---

## Project Structure

```
prediction-market/
├── index.js                    # Boot sequence and agent orchestration
├── core/
│   ├── db.js                   # Supabase client and table bootstrap
│   ├── persistence.js          # All database operations
│   ├── geminiValidator.js      # Gemini live-search trade validator
│   ├── polymarketClient.js     # Polymarket CLOB and Gamma API client
│   ├── newsFetcher.js          # Multi-source news aggregation
│   ├── riskManager.js          # Kelly sizing and approval gate
│   ├── stateStore.js           # In-memory state with EventEmitter
│   └── logger.js               # Winston rotating file logger
├── agents/
│   ├── baseAgent.js            # Two-model pipeline + Gemini validation
│   └── specializedAgents.js    # Six domain agents
├── dashboard/
│   ├── server.js               # Express + WebSocket server
│   └── public/index.html       # Real-time monitoring dashboard
└── docs/
    ├── Polybot_PRD.pdf
    └── Polybot_System_Design.pdf
```

---

## Disclaimer

This software is provided for educational and experimental purposes. Prediction market trading involves substantial risk of loss. The authors are not responsible for any financial losses incurred while using this system. Always test in READ-ONLY simulation mode before deploying with real funds.
