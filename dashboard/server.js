'use strict';
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path       = require('path');
const { WebSocketServer } = require('ws');
const logger      = require('../core/logger');
const stateStore  = require('../core/stateStore');
const riskManager = require('../core/riskManager');
const newsFetcher = require('../core/newsFetcher');

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT) || 3000;
const WS_PORT        = parseInt(process.env.WS_PORT)        || 3001;

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST Endpoints (SDD 5.1) ──────────────────────────────────────────────────

// GET /api/state — full snapshot
app.get('/api/state', (_req, res) => {
  res.json({
    ...stateStore.snapshot(),
    riskStats:    riskManager.getStats(),
    gnewsBudget:  newsFetcher.getBudgetStatus(),
    tfStatus:     newsFetcher.getTFStatus()
  });
});

// POST /api/engine/stop
app.post('/api/engine/stop', (_req, res) => {
  stateStore.setEngineRunning(false);
  logger.info('Dashboard: Engine stopped by user');
  res.json({ ok: true, engineRunning: false });
});

// POST /api/engine/start
app.post('/api/engine/start', (_req, res) => {
  if (stateStore.engineHalted) {
    // Don't auto-resume if halted by loss limit — use reset-daily first
    return res.status(400).json({ ok: false, error: 'Engine halted by daily loss limit. Reset daily P&L first.' });
  }
  stateStore.setEngineRunning(true);
  logger.info('Dashboard: Engine started by user');
  res.json({ ok: true, engineRunning: true });
});

// POST /api/risk/reset-daily — reset daily P&L, resume if halted
app.post('/api/risk/reset-daily', (_req, res) => {
  stateStore.resetDailyPnl();
  if (stateStore.engineHalted) {
    stateStore.resumeEngine();
    logger.info('Dashboard: Daily P&L reset and engine resumed');
  }
  res.json({ ok: true, dailyPnl: 0 });
});

// POST /api/trade/manual — manual trade override via event
app.post('/api/trade/manual', (req, res) => {
  const { question, category, probability, stake } = req.body;
  if (!question || !category) {
    return res.status(400).json({ ok: false, error: 'question and category are required' });
  }
  const payload = {
    question,
    category,
    probability: parseFloat(probability) || 50,
    stake: parseFloat(stake) || parseFloat(process.env.MIN_STAKE_USD) || 1,
    ts: Date.now()
  };
  stateStore.emit('manual_trade', payload);
  logger.info(`Dashboard: Manual trade submitted — "${question}"`);
  res.json({ ok: true, queued: payload });
});

// ── HTTP Server ───────────────────────────────────────────────────────────────

const httpServer = http.createServer(app);

// ── WebSocket Server (SDD 5.2) ────────────────────────────────────────────────

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`WebSocket port ${WS_PORT} already in use — kill existing process and restart`);
    process.exit(1);
  }
  logger.error(`WebSocket server error: ${err.message}`, { code: err.code });
});
const clients = new Set();

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); } catch (_) { /* ignore */ }
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  logger.info(`Dashboard: WebSocket client connected (${clients.size} total)`);

  // Send snapshot immediately on connect
  try {
    ws.send(JSON.stringify({
      type: 'snapshot',
      payload: { ...stateStore.snapshot(), riskStats: riskManager.getStats() },
      ts: Date.now()
    }));
  } catch (_) { /* ignore */ }

  ws.on('close', () => {
    clients.delete(ws);
    logger.info(`Dashboard: WebSocket client disconnected (${clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    logger.warn(`Dashboard: WebSocket error — ${err.message}`);
    clients.delete(ws);
  });
});

// ── State → WebSocket bridge ──────────────────────────────────────────────────

stateStore.on('trade',        payload => broadcast('trade', payload));
stateStore.on('trade_update', payload => broadcast('trade_update', payload));
stateStore.on('pnl',          payload => broadcast('pnl', payload));
stateStore.on('agent',        payload => broadcast('agent', payload));
stateStore.on('news',         payload => broadcast('news', payload));
stateStore.on('state',        payload => broadcast('state', payload));
// Data API real on-chain events
stateStore.on('positions',    payload => broadcast('positions', payload));
stateStore.on('pnl_real',     payload => broadcast('pnl_real', payload));
stateStore.on('trades_real',  payload => broadcast('trades_real', payload));

// ── Start servers ─────────────────────────────────────────────────────────────

function startDashboard() {
  return new Promise((resolve) => {
    httpServer.listen(DASHBOARD_PORT, '127.0.0.1', () => {
      logger.info(`Dashboard: HTTP server running at http://localhost:${DASHBOARD_PORT}`);
      logger.info(`Dashboard: WebSocket server running on port ${WS_PORT}`);
      resolve();
    });
  });
}

module.exports = { startDashboard, broadcast };
