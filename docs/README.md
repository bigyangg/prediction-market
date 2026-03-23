# Polybot Documentation

This directory contains the primary design and requirements documents for Polybot.

- **`Polybot_PRD.pdf`** — Product Requirements Document. Covers agent functions, data flows, user stories, and feature requirements for the autonomous trading engine.
- **`Polybot_System_Design.pdf`** — Technical architecture and system design specification. Includes API sequence diagrams for Polymarket CLOB, Gamma API, and the two-model Claude pipeline.

For setup, configuration, and full architecture documentation see the main [`README.md`](../README.md).

---

## What Has Changed Since the PDFs Were Written

The PDFs describe the original v1.0 design. The current codebase reflects several significant additions:

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
