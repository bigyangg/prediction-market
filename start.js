#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Polybot Start Script — PM2 + Ngrok
// ═══════════════════════════════════════════════════════════════════════════
// Usage:
//   node start.js              → Start bot via PM2 + open ngrok tunnel
//   node start.js --no-tunnel  → Start bot via PM2 only (no public URL)
//   node start.js --stop       → Stop everything
// ═══════════════════════════════════════════════════════════════════════════

const { execSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT) || 3000;
const NGROK_LOG = path.join(__dirname, 'logs', 'ngrok.log');
const TUNNEL_INFO = path.join(__dirname, '.tunnel-url');

// ── Helpers ───────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

function waitForHealth(url, maxWaitMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get(url, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.status === 'ok') return resolve(j);
          } catch {}
          if (Date.now() - start > maxWaitMs) return reject(new Error('Health check timeout'));
          setTimeout(check, 1000);
        });
      }).on('error', () => {
        if (Date.now() - start > maxWaitMs) return reject(new Error('Health check timeout'));
        setTimeout(check, 1000);
      });
    };
    check();
  });
}

// ── Stop ──────────────────────────────────────────────────────────────────

if (process.argv.includes('--stop')) {
  log('⏹  Stopping Polybot…');
  run('pm2 stop polybot');
  run('pm2 delete polybot');
  log('⏹  Stopping ngrok…');
  run('ngrok http close-all 2>nul');
  // Kill any ngrok processes
  try { run('taskkill /F /IM ngrok.exe 2>nul'); } catch {}
  if (fs.existsSync(TUNNEL_INFO)) fs.unlinkSync(TUNNEL_INFO);
  log('✅ Everything stopped.');
  process.exit(0);
}

// ── Start ─────────────────────────────────────────────────────────────────

async function start() {
  const noTunnel = process.argv.includes('--no-tunnel');

  // Ensure logs directory exists
  if (!fs.existsSync(path.join(__dirname, 'logs'))) {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  }

  // ── Step 1: Start bot via PM2 ─────────────────────────────────────────
  log('🚀 Starting Polybot via PM2…');

  // Stop any existing instance
  run('pm2 stop polybot 2>nul');
  run('pm2 delete polybot 2>nul');

  // Start fresh
  const pm2Out = run(`pm2 start ecosystem.config.js`);
  log(pm2Out || '   PM2 started');

  // ── Step 2: Wait for health check ─────────────────────────────────────
  log(`⏳ Waiting for health check at http://localhost:${PORT}/health …`);
  try {
    const health = await waitForHealth(`http://localhost:${PORT}/health`, 45000);
    log(`✅ Bot is healthy — uptime: ${health.uptime?.toFixed(0)}s, engine: ${health.engineRunning ? 'RUNNING' : 'STOPPED'}`);
  } catch {
    log('⚠️  Health check timed out — bot may still be starting. Check: pm2 logs polybot');
  }

  // ── Step 3: Open ngrok tunnel ─────────────────────────────────────────
  if (!noTunnel) {
    log('🌐 Starting ngrok tunnel…');

    // Kill any existing ngrok
    try { run('taskkill /F /IM ngrok.exe 2>nul'); } catch {}

    // Start ngrok in background
    const ngrok = spawn('ngrok', ['http', String(PORT), '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      shell: true
    });

    ngrok.unref();

    // Give ngrok time to establish tunnel
    await new Promise(r => setTimeout(r, 4000));

    // Get the public URL from ngrok API
    try {
      const tunnelUrl = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              const tunnel = data.tunnels?.find(t => t.proto === 'https') || data.tunnels?.[0];
              if (tunnel?.public_url) resolve(tunnel.public_url);
              else reject(new Error('No tunnel found'));
            } catch (e) {
              reject(e);
            }
          });
        }).on('error', reject);
      });

      // Save tunnel URL to file for reference
      fs.writeFileSync(TUNNEL_INFO, tunnelUrl);

      log('');
      log('═══════════════════════════════════════════════════════════');
      log('  🌐 PUBLIC URL:');
      log(`     Dashboard:  ${tunnelUrl}`);
      log(`     Health:     ${tunnelUrl}/health`);
      log(`     WebSocket:  ${tunnelUrl.replace('https://', 'wss://')}/ws`);
      log(`     State API:  ${tunnelUrl}/api/state`);
      log('');
      log('  📍 LOCAL URL:');
      log(`     Dashboard:  http://localhost:${PORT}`);
      log(`     Health:     http://localhost:${PORT}/health`);
      log('');
      log('  🔧 MANAGEMENT:');
      log('     pm2 logs polybot      — View live logs');
      log('     pm2 monit             — Real-time monitoring');
      log('     pm2 restart polybot   — Restart bot');
      log('     node start.js --stop  — Stop everything');
      log('═══════════════════════════════════════════════════════════');
    } catch (e) {
      log(`⚠️  Could not get ngrok URL: ${e.message}`);
      log('   Make sure ngrok is authenticated: ngrok config add-authtoken YOUR_TOKEN');
      log('   Get a free token at: https://dashboard.ngrok.com/signup');
      log('');
      log('   Bot is still running locally via PM2:');
      log(`   Dashboard: http://localhost:${PORT}`);
    }
  } else {
    log('');
    log('═══════════════════════════════════════════════════════════');
    log('  📍 LOCAL ONLY (no tunnel):');
    log(`     Dashboard:  http://localhost:${PORT}`);
    log(`     Health:     http://localhost:${PORT}/health`);
    log('');
    log('  🔧 MANAGEMENT:');
    log('     pm2 logs polybot      — View live logs');
    log('     pm2 monit             — Real-time monitoring');
    log('     pm2 restart polybot   — Restart bot');
    log('     node start.js --stop  — Stop everything');
    log('═══════════════════════════════════════════════════════════');
  }

  log('');
  log('✅ Polybot is live! PM2 will auto-restart on crash.');
}

start().catch(e => {
  log(`❌ Startup failed: ${e.message}`);
  process.exit(1);
});
