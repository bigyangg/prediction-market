# Railway Deployment

> **Note**: This deployment guide is for Polybot v2.1+ which includes critical fixes for order placement, balance display, and CLOB API compliance. See [`CHANGELOG.md`](CHANGELOG.md) for details.

## Steps

1. Push code to GitHub:
   ```
   git init
   git add .
   git commit -m "Polybot initial deploy"
   git remote add origin https://github.com/YOUR_USERNAME/polybot.git
   git push -u origin main
   ```

2. Go to railway.app → New Project → Deploy from GitHub repo.
   Select your polybot repo.

3. Railway will auto-detect Node.js and run `npm install` + `node index.js`.

4. Add ALL environment variables in Railway dashboard:
   Project → Variables → Add all from `.env.example`

   Required variables:
   ```
   ANTHROPIC_API_KEY
   GEMINI_API_KEY
   POLYMARKET_PRIVATE_KEY
   POLYMARKET_FUNDER_ADDRESS
   POLYMARKET_SIGNATURE_TYPE
   SUPABASE_URL
   SUPABASE_ANON_KEY
   TINYFISH_API_KEY        (optional)
   GNEWS_API_KEY           (optional)
   SCOUT_MODEL
   JUDGE_MODEL
   GEMINI_MODEL
   MAX_STAKE_USD
   MIN_STAKE_USD
   DAILY_LOSS_LIMIT_USD
   MAX_OPEN_TRADES
   MIN_EDGE_PCT
   MIN_CONFIDENCE_PCT
   SCAN_INTERVAL_SECONDS
   ```

5. Railway auto-assigns a public URL like:
   `https://polybot-production.up.railway.app`

   Your dashboard is live at that URL.

6. To see logs: Railway dashboard → your service → Logs tab.

7. To redeploy: just push to GitHub main branch:
   ```
   git push origin main
   ```

## Important notes

- Railway free tier: 500 hours/month — enough for 24/7 with one service
- Upgrade to $5/month for unlimited hours (recommended for 24/7 trading)
- All secrets stay in Railway Variables — never in code
- Supabase handles all persistence — restarts lose nothing
- Railway health check hits `/health` every 30s
- HTTP dashboard and WebSocket both run on the single Railway-assigned `PORT`
  - Dashboard: `https://your-app.railway.app`
  - WebSocket: `wss://your-app.railway.app/ws`

## Test Railway-like environment locally

```
PORT=8080 node index.js
```

Confirm:
- App starts on port 8080
- Dashboard loads at http://localhost:8080
- WebSocket connects to ws://localhost:8080/ws
- `/health` endpoint returns JSON
- All agents start normally

## Supabase RLS Setup

Supabase enables Row Level Security (RLS) by default, which **blocks all writes** from the anon key unless you add policies. If Supabase tables exist but no data appears, RLS is the cause.

**Option A — Disable RLS (easiest for a private bot):**

Go to each table in **Supabase → Table Editor**, click the shield icon, click **Disable RLS**.
Do this for all 5 tables: `trades`, `agent_decisions`, `market_cache`, `news_cache`, `daily_stats`

**Option B — Add permissive policies (more secure):**

Run this in **Supabase → SQL Editor**:

```sql
CREATE POLICY "allow_all" ON trades           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON agent_decisions  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON market_cache     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON news_cache       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON daily_stats      FOR ALL USING (true) WITH CHECK (true);
```

**Verification:** On boot, look for `Supabase write test: PASSED ✓`. If you see `FAILED`, RLS is blocking writes — apply Option A or B above.

---

## Cost estimate (monthly)

| Service    | Cost                              |
|------------|-----------------------------------|
| Railway    | $5/month (Hobby plan)             |
| Supabase   | Free tier (500MB, plenty)         |
| Anthropic  | ~$10–30 depending on scan freq    |
| Gemini     | Free tier covers bot usage        |
| **Total**  | **~$15–35/month**                 |
