'use strict';
const { supabase } = require('./db');
const logger = require('./logger');

let enabled = false;
const setEnabled = (val) => { enabled = val; };

// ─── Trades ───────────────────────────────────────────────────────────────────

async function saveTrade(trade) {
  if (!enabled) return null;
  try {
    const { error } = await supabase.from('trades').upsert({
      id:               trade.id,
      agent:            trade.agent,
      category:         trade.category,
      question:         trade.question || trade.market,
      market_slug:      trade.marketSlug,
      trade:            trade.trade || trade.side,
      stake:            trade.stake,
      edge:             trade.edge,
      confidence:       trade.confidence,
      market_prob:      trade.marketProb,
      true_prob:        trade.trueProb,
      risk_level:       trade.riskLevel || trade.risk_level,
      reason:           trade.reason,
      key_factor:       trade.keyFactor || trade.key_factor,
      warning:          trade.warning,
      status:           trade.status,
      gemini_validated: trade.geminiValidated || false,
      gemini_verdict:   trade.geminiVerdict,
      gemini_reason:    trade.geminiReason,
      pnl:              trade.pnl,
      opened_at:        trade.openedAt || trade.ts,
      order_id:         trade.orderId,
      decision_model:   trade.decisionModel,
      dual_confirmed:   trade.dualConfirmed || false
    });
    if (error) {
      logger.error('saveTrade FAILED', { error: error.message, code: error.code, tradeId: trade.id });
      return false;
    }
    logger.debug('saveTrade OK', { tradeId: trade.id });
    return true;
  } catch (e) {
    logger.error('saveTrade exception', { error: e.message, tradeId: trade.id });
    return null;
  }
}

async function updateTrade(id, patch) {
  if (!enabled) return null;
  try {
    const update = {};
    if (patch.status    !== undefined) update.status         = patch.status;
    if (patch.pnl       !== undefined) update.pnl            = patch.pnl;
    if (patch.orderId   !== undefined) update.order_id       = patch.orderId;
    if (patch.closedAt  !== undefined) update.closed_at      = patch.closedAt;
    if (patch.geminiValidated !== undefined) update.gemini_validated = patch.geminiValidated;
    if (patch.geminiVerdict   !== undefined) update.gemini_verdict   = patch.geminiVerdict;
    if (patch.geminiReason    !== undefined) update.gemini_reason    = patch.geminiReason;

    const { error } = await supabase.from('trades').update(update).eq('id', id);
    if (error) logger.debug('updateTrade error', { error: error.message });
  } catch (e) {
    logger.debug('updateTrade exception', { error: e.message });
  }
}

async function loadRecentTrades(limit = 100) {
  if (!enabled) return [];
  try {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
}

// ─── Agent decisions ──────────────────────────────────────────────────────────

async function saveDecision(decision) {
  if (!enabled) return null;
  try {
    const { error } = await supabase.from('agent_decisions').insert({
      agent:              decision.agent,
      market_id:          decision.marketId,
      question:           decision.question,
      category:           decision.category,
      scout_verdict:      decision.scoutVerdict,
      scout_reason:       decision.scoutReason,
      claude_trade:       decision.claudeTrade,
      claude_edge:        decision.claudeEdge,
      claude_confidence:  decision.claudeConfidence,
      claude_true_prob:   decision.claudeTrueProb,
      claude_risk:        decision.claudeRisk,
      claude_reason:      decision.claudeReason,
      gemini_verdict:     decision.geminiVerdict,
      gemini_confidence:  decision.geminiConfidence,
      gemini_reason:      decision.geminiReason,
      final_action:       decision.finalAction,
      rejection_reason:   decision.rejectionReason
    });
    if (error) {
      logger.error('saveDecision FAILED', { error: error.message, code: error.code });
    } else {
      logger.debug('saveDecision OK');
    }
  } catch (e) {
    logger.error('saveDecision exception', { error: e.message });
  }
}

// ─── Market cache ─────────────────────────────────────────────────────────────

async function getCachedMarkets(maxAgeMinutes = 10) {
  if (!enabled) return null;
  try {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('market_cache')
      .select('*')
      .gte('cached_at', cutoff)
      .order('volume_24hr', { ascending: false });

    if (error || !data || data.length === 0) return null;

    return data.map(m => ({
      id:              m.id,
      question:        m.question,
      category:        m.category,
      marketProb:      m.market_prob,
      volume24hr:      m.volume_24hr,
      liquidity:       m.liquidity,
      bestAsk:         m.best_ask,
      bestBid:         m.best_bid,
      tokenIds:        m.token_ids || [],
      tokens:          (m.token_ids || []).map((id, i) => ({ token_id: id, outcome: i === 0 ? 'Yes' : 'No' })),
      negRisk:         m.neg_risk,
      minimumTickSize: m.min_tick || '0.01',
      endDate:         m.end_date,
      slug:            m.slug,
      active:          true,
      closed:          false,
      acceptingOrders: true
    }));
  } catch (e) {
    return null;
  }
}

async function cacheMarkets(markets) {
  if (!enabled || !markets?.length) return;
  try {
    const rows = markets.map(m => ({
      id:          m.id || m.conditionId,
      question:    m.question,
      category:    m.category,
      market_prob: m.marketProb,
      volume_24hr: m.volume24hr,
      liquidity:   m.liquidity,
      best_ask:    m.bestAsk,
      best_bid:    m.bestBid,
      token_ids:   m.tokenIds || [],
      neg_risk:    m.negRisk,
      min_tick:    m.minimumTickSize,
      end_date:    m.endDate,
      slug:        m.slug,
      cached_at:   new Date().toISOString()
    }));

    const { error } = await supabase.from('market_cache').upsert(rows, { onConflict: 'id' });
    if (error) {
      logger.error('cacheMarkets FAILED', { error: error.message, code: error.code });
    } else {
      logger.info('Market cache updated in Supabase', { count: rows.length });
    }
  } catch (e) {
    logger.debug('cacheMarkets exception', { error: e.message });
  }
}

// ─── Daily stats ──────────────────────────────────────────────────────────────

async function updateDailyStats(stats) {
  if (!enabled) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const { error } = await supabase.from('daily_stats').upsert({
      date:            today,
      total_pnl:       stats.totalPnl,
      daily_pnl:       stats.dailyPnl,
      total_trades:    stats.totalTrades,
      winning_trades:  stats.wins,
      losing_trades:   stats.losses,
      scans_completed: stats.scansCompleted,
      gemini_vetos:    stats.geminiVetos || 0,
      updated_at:      new Date().toISOString()
    }, { onConflict: 'date' });
    if (error) {
      logger.error('updateDailyStats FAILED', { error: error.message, code: error.code });
    }
  } catch (e) {
    logger.error('updateDailyStats exception', { error: e.message });
  }
}

async function getDailyStats(days = 7) {
  if (!enabled) return [];
  try {
    const { data, error } = await supabase
      .from('daily_stats')
      .select('*')
      .order('date', { ascending: false })
      .limit(days);
    return data || [];
  } catch (e) {
    return [];
  }
}

// ─── News cache ───────────────────────────────────────────────────────────────

async function getCachedNews(key, maxAgeMinutes = 5) {
  if (!enabled) return null;
  try {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('news_cache')
      .select('data')
      .eq('key', key)
      .gte('cached_at', cutoff)
      .single();
    return data?.data || null;
  } catch (e) {
    return null;
  }
}

async function setCachedNews(key, category, source, data) {
  if (!enabled) return;
  try {
    await supabase.from('news_cache').upsert({
      key, category, source, data,
      cached_at: new Date().toISOString()
    }, { onConflict: 'key' });
  } catch (e) { /* silent */ }
}

module.exports = {
  setEnabled,
  saveTrade, updateTrade, loadRecentTrades,
  saveDecision,
  getCachedMarkets, cacheMarkets,
  updateDailyStats, getDailyStats,
  getCachedNews, setCachedNews
};
