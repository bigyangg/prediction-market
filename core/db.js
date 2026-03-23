'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const supabase = createClient(
  process.env.SUPABASE_URL    || '',
  process.env.SUPABASE_ANON_KEY || '',
  {
    realtime: { params: { eventsPerSecond: 10 } },
    db: { schema: 'public' }
  }
);

// ─── Table bootstrap ─────────────────────────────────────────────────────────
// Run once on boot — tests connection and logs setup SQL if tables missing

async function bootstrap() {
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL.includes('your-project')) {
    logger.info('Supabase: not configured — running without persistence');
    return false;
  }

  logger.info('Supabase config check', {
    url: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 30) + '...' : 'MISSING',
    key: process.env.SUPABASE_ANON_KEY ? process.env.SUPABASE_ANON_KEY.slice(0, 20) + '...' : 'MISSING'
  });

  try {
    const { data, error } = await supabase
      .from('trades')
      .select('count')
      .limit(1);

    if (error && error.code === '42P01') {
      // Tables don't exist — log SQL for user to run
      logger.warn('Supabase tables not found. Run this SQL in your Supabase SQL editor:');
      logger.warn(`
-- Copy and run this in: supabase.com → your project → SQL Editor

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  category TEXT,
  question TEXT,
  market_slug TEXT,
  trade TEXT NOT NULL,
  stake NUMERIC,
  edge NUMERIC,
  confidence INTEGER,
  market_prob NUMERIC,
  true_prob NUMERIC,
  risk_level TEXT,
  reason TEXT,
  key_factor TEXT,
  warning TEXT,
  status TEXT DEFAULT 'open',
  gemini_validated BOOLEAN DEFAULT FALSE,
  gemini_verdict TEXT,
  gemini_reason TEXT,
  pnl NUMERIC,
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  order_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id BIGSERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  market_id TEXT,
  question TEXT,
  category TEXT,
  scout_verdict TEXT,
  scout_reason TEXT,
  claude_trade TEXT,
  claude_edge NUMERIC,
  claude_confidence INTEGER,
  claude_true_prob NUMERIC,
  claude_risk TEXT,
  claude_reason TEXT,
  gemini_verdict TEXT,
  gemini_confidence INTEGER,
  gemini_reason TEXT,
  final_action TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_cache (
  id TEXT PRIMARY KEY,
  question TEXT,
  category TEXT,
  market_prob NUMERIC,
  volume_24hr NUMERIC,
  liquidity NUMERIC,
  best_ask NUMERIC,
  best_bid NUMERIC,
  token_ids JSONB,
  neg_risk BOOLEAN,
  min_tick TEXT,
  end_date TEXT,
  slug TEXT,
  raw JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_stats (
  date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  total_pnl NUMERIC DEFAULT 0,
  daily_pnl NUMERIC DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  total_edge_avg NUMERIC DEFAULT 0,
  scans_completed INTEGER DEFAULT 0,
  gemini_vetos INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news_cache (
  key TEXT PRIMARY KEY,
  category TEXT,
  source TEXT,
  data JSONB,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable realtime on trades and agent_decisions tables
ALTER PUBLICATION supabase_realtime ADD TABLE trades;
ALTER PUBLICATION supabase_realtime ADD TABLE agent_decisions;
ALTER PUBLICATION supabase_realtime ADD TABLE daily_stats;
      `);
      return false;
    }

    if (error) {
      logger.error('Supabase connection test FAILED', {
        code:    error.code,
        message: error.message,
        hint:    error.hint
      });
      return false;
    }

    logger.info('Supabase connection test PASSED ✓ — tables verified');
    return true;

  } catch (e) {
    logger.warn('Supabase connection failed — running without persistence', { error: e.message });
    return false;
  }
}

module.exports = { supabase, bootstrap };
