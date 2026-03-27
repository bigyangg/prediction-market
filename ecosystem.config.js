// PM2 Ecosystem Configuration for Polybot
// Usage: pm2 start ecosystem.config.js
// Docs:  https://pm2.keymetrics.io/docs/usage/application-declaration/

module.exports = {
  apps: [
    {
      name: 'polybot',
      script: 'index.js',
      cwd: __dirname,

      // ── Auto-restart ────────────────────────────────────────────────
      autorestart: true,
      watch: false,                    // Use `pm2 start --watch` to enable
      max_restarts: 50,                // Max restarts in restart_delay window
      restart_delay: 5000,             // 5s between restarts
      exp_backoff_restart_delay: 1000, // Exponential backoff on crash loops

      // ── Memory / CPU ────────────────────────────────────────────────
      max_memory_restart: '512M',      // Restart if memory exceeds 512MB
      node_args: '--max-old-space-size=512',

      // ── Logging ─────────────────────────────────────────────────────
      log_file: './logs/pm2-combined.log',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // ── Environment ─────────────────────────────────────────────────
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3000
      }
    }
  ]
};
