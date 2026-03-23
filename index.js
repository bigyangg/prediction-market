'use strict';
require('dotenv').config();
const cron        = require('node-cron');
const axios       = require('axios');
const logger      = require('./core/logger');
const stateStore  = require('./core/stateStore');
const riskManager = require('./core/riskManager');
const polymarket  = require('./core/polymarketClient');
const newsFetcher = require('./core/newsFetcher');
const { startDashboard } = require('./dashboard/server');
const {
  CryptoAgent,
  PoliticsAgent,
  EconomicsAgent,
  SportsAgent,
  WeatherAgent,
  OddsAgent
} = require('./agents/specializedAgents');

// ── Banner ────────────────────────────────────────────────────────────────────

logger.info('╔════════════════════════════════════════╗');
logger.info('║           POLYBOT v1.0                 ║');
logger.info('║   Autonomous Polymarket Trading Engine ║');
logger.info('╚════════════════════════════════════════╝');

// ── Boot Sequence ─────────────────────────────────────────────────────────────

async function boot() {
  try {
    // 1. Wallet init (derives API creds, starts heartbeat, checks geoblock)
    logger.info('[Boot] Initializing wallet…');
    await polymarket.init();

    // Test Gamma API connectivity
    try {
      const testRes = await axios.get('https://gamma-api.polymarket.com/markets', {
        params: { limit: 1, active: true },
        timeout: 10000
      });
      logger.info('Gamma API connectivity: OK', { sampleCount: testRes.data?.length || 0 });
    } catch (err) {
      logger.error('Gamma API connectivity: FAILED', {
        status:  err.response?.status,
        message: err.message
      });
      logger.error('Markets will not load — check internet connection or Gamma API status');
    }

    // Seed wallet state using funder address (the actual Polymarket trading wallet)
    const funderAddr = process.env.POLYMARKET_FUNDER_ADDRESS || polymarket.wallet?.address || null;
    const initBal    = await polymarket.getUSDCBalance().catch(() => '0.00');
    stateStore.setWallet(funderAddr, parseFloat(initBal));

    if (stateStore.readOnly) {
      logger.warn('[Boot] READ-ONLY mode — no real orders will be placed');
    } else {
      logger.info(`[Boot] Funder: ${funderAddr} | Balance: $${initBal} USDC`);
    }

    // 2. Start dashboard
    logger.info('[Boot] Starting dashboard…');
    await startDashboard();

    // 3. Instantiate all 6 agents
    const agents = [
      new CryptoAgent(),
      new PoliticsAgent(),
      new EconomicsAgent(),
      new SportsAgent(),
      new WeatherAgent(),
      new OddsAgent()
    ];

    // 4. Start agents staggered 3s apart
    logger.info('[Boot] Starting agents with 3s stagger…');
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const staggerMs = i * 3000; // 3 seconds between each agent
      agent.start(staggerMs);
      logger.info(`[Boot] Agent queued: ${agent.name} (starts in ${staggerMs / 1000}s)`);
    }

    // 5. Manual trade handler
    stateStore.on('manual_trade', async (payload) => {
      logger.info(`[Manual] Processing manual trade: "${payload.question}"`);
      // Route to OddsAgent (general purpose) for manual analysis
      const manualAgent = agents.find(a => a.name === 'OddsAgent') || agents[0];
      try {
        const mockMarket = {
          id: `manual_${Date.now()}`,
          question: payload.question,
          title: payload.question,
          volume24hr: 10000,
          liquidity: 10000,
          outcomePrices: JSON.stringify([payload.probability / 100, 1 - payload.probability / 100])
        };
        const newsCtx = await newsFetcher.getContextForCategory(payload.category || 'odds');
        await manualAgent.analyzeMarket(mockMarket, newsCtx, 'manual');
      } catch (err) {
        logger.error(`[Manual] Failed: ${err.message}`);
      }
    });

    // 5b. Data API polling — real on-chain positions/trades/PnL every 30s
    const pollDataAPI = async () => {
      try {
        const [pnlData, trades] = await Promise.all([
          polymarket.getRealPnL(),
          polymarket.getRealTrades(30)
        ]);
        stateStore.setRealPnl(pnlData);
        stateStore.setRealPositions(pnlData.positions);
        stateStore.setRealTrades(trades);
        stateStore.pushPnl(pnlData.totalCashPnl); // feeds P&L chart with real data
        const bal = await polymarket.getUSDCBalance();
        stateStore.setWallet(
          process.env.POLYMARKET_FUNDER_ADDRESS || polymarket.wallet?.address,
          parseFloat(bal)
        );
        logger.info(`[DataAPI] Poll complete — ${pnlData.openPositionCount} positions, cashPnl=$${pnlData.totalCashPnl}`);
      } catch (err) {
        logger.warn('[DataAPI] Poll failed', { error: err.message });
      }
    };
    pollDataAPI(); // immediate first call
    const dataPollInterval = setInterval(pollDataAPI, 30000);
    // Instant re-poll on confirmed on-chain trade (from user WebSocket)
    stateStore.on('trigger_data_poll', () => {
      logger.info('[DataAPI] Instant re-poll triggered by on-chain trade confirmation');
      pollDataAPI();
    });

    // 6. Midnight UTC cron — reset daily P&L
    cron.schedule('0 0 * * *', () => {
      logger.info('[Cron] Midnight UTC — resetting daily P&L');
      stateStore.resetDailyPnl();
      // Resume engine if it was halted by daily loss limit
      if (stateStore.engineHalted) {
        stateStore.resumeEngine();
        logger.info('[Cron] Engine resumed after daily reset');
      }
    }, { timezone: 'UTC' });

    // 7. (Wallet refresh is now handled by Data API poll every 30s above)

    // ── Print agent summary ────────────────────────────────────────────────
    logger.info('══════════════════════════════════════════');
    logger.info('  ALL AGENTS INITIALIZED:');
    for (const agent of agents) {
      logger.info(`  ✓ ${agent.name.padEnd(18)} category=${agent.category.padEnd(10)} interval=${agent.intervalSeconds}s`);
    }
    logger.info(`  Dashboard: http://localhost:${process.env.DASHBOARD_PORT || 3000}`);
    logger.info(`  WebSocket: ws://localhost:${process.env.WS_PORT || 3001}`);
    logger.info(`  Mode:      ${stateStore.readOnly ? 'READ-ONLY (simulation)' : 'LIVE TRADING'}`);
    logger.info('══════════════════════════════════════════');

    // 8. Graceful shutdown
    process.on('SIGINT', () => shutdown(agents));
    process.on('SIGTERM', () => shutdown(agents));

  } catch (err) {
    logger.error(`[Boot] Fatal error: ${err.message}`);
    logger.error(err.stack);
    process.exit(1);
  }
}

function shutdown(agents) {
  logger.info('[Shutdown] Stopping all agents…');
  for (const agent of agents) {
    agent.stop();
  }
  stateStore.setEngineRunning(false);
  logger.info('[Shutdown] Polybot stopped. Goodbye.');
  setTimeout(() => process.exit(0), 1000);
}

boot();
