'use strict';
require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path       = require('path');
const { WebSocketServer } = require('ws');
const logger      = require('../core/logger');
const stateStore  = require('../core/stateStore');
const riskManager = require('../core/riskManager');
const newsFetcher     = require('../core/newsFetcher');
const geminiValidator = require('../core/geminiValidator');

const HTTP_PORT = parseInt(process.env.PORT) || parseInt(process.env.HTTP_PORT) || 3000;

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health Check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    engineRunning: stateStore.engineRunning,
    halted: stateStore.engineHalted,
    scans: stateStore.scansCompleted,
    timestamp: new Date().toISOString()
  });
});

// ── REST Endpoints (SDD 5.1) ──────────────────────────────────────────────────

// GET /api/state — full snapshot
app.get('/api/state', (_req, res) => {
  res.json({
    ...stateStore.snapshot(),
    riskStats:      riskManager.getStats(),
    gnewsBudget:    newsFetcher.getBudgetStatus(),
    tfStatus:       newsFetcher.getTFStatus(),
    geminiStats:    geminiValidator.getStats()
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
    // Halted by daily loss limit — resume clears the halt flag and restarts
    stateStore.resumeEngine();
    logger.info('Dashboard: Engine resumed from halt by user (daily loss limit override)');
    return res.json({ ok: true, engineRunning: true, note: 'resumed from halt' });
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

// GET /api/traders — sharp trader tracker summary
app.get('/api/traders', (_req, res) => {
  const traderTracker = require('../core/traderTracker');
  res.json(traderTracker.getSummary());
});

// POST /api/traders/add — manually add a wallet to watch list
app.post('/api/traders/add', (req, res) => {
  const { address, alias } = req.body;
  if (!address) return res.status(400).json({ error: 'address required' });
  const traderTracker = require('../core/traderTracker');
  if (traderTracker.wallets.find(w => w.address === address)) {
    return res.json({ ok: true, note: 'already watching', total: traderTracker.wallets.length });
  }
  traderTracker.wallets.push({ address, alias: alias || 'Manual', description: 'Added via dashboard' });
  logger.info(`Dashboard: tracking new wallet ${alias || address.slice(0, 8)}`);
  res.json({ ok: true, total: traderTracker.wallets.length });
});

// GET /api/config — safely expose public keys for dashboard Supabase realtime
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL  || '',
    supabaseKey: process.env.SUPABASE_ANON_KEY || ''
  });
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

const wss = new WebSocketServer({ noServer: true });
wss.on('error', (err) => {
  logger.error(`WebSocket server error: ${err.message}`, { code: err.code });
});

httpServer.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
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
    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
      logger.info(`Dashboard: http://localhost:${HTTP_PORT}`);
      logger.info(`Dashboard: WebSocket at ws://localhost:${HTTP_PORT}/ws`);
      if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        logger.info(`Railway URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
      }
      resolve();
    });
  });
}

module.exports = { startDashboard, broadcast };
