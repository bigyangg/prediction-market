# Polybot v1.0 🤖📈

**Autonomous Polymarket Trading Engine**

Polybot is an advanced, fully autonomous algorithmic trading system designed for [Polymarket](https://polymarket.com/). Leveraging specialized AI agents, real-time news integration, and robust risk management, Polybot continuously analyzes markets, assesses probabilities, and executes trades across various domains.

---

## 🚀 Key Features

- **6 Specialized AI Agents**: Dedicated agents for `Crypto`, `Politics`, `Economics`, `Sports`, `Weather`, and general `Odds`. 
- **LLM-Powered Analysis**: Uses the Anthropic Claude SDK to evaluate market conditions, news sentiment, and statistical probabilities.
- **Real-Time Data Integration**: Fetches real-time news context via GNews and evaluates on-chain Polymarket data (order books, liquidity, active markets).
- **Automated Risk Management**: Built-in daily P&L tracking, automated exposure limits, and midnight UTC resets.
- **Live Dashboard**: A built-in Express/WebSocket dashboard for monitoring active positions, PnL charts, and agent logs in real-time.
- **Simulation Mode**: Run in **READ-ONLY** mode to backtest and simulate trading decisions without risking real funds.

---

## 🏗 System Architecture

The trading engine is built on Node.js and orchestrates several core modules:

1. **Boot Sequence**: Initializes wallet, validates Gamma API connectivity, and seeds initial state.
2. **Dashboard**: Starts the local server UI (`http://localhost:3000`) for system monitoring.
3. **Agent Orchestration**: Six AI agents are staggered (3s intervals) to continuously poll their respective domains for trade opportunities.
4. **Data Poller**: Every 30 seconds, the engine synchronizes on-chain trade history, real PnL, and open positions.

For a detailed breakdown, please see the PRD and System Design PDFs located in the `docs/` directory.

---

## 🛠 Prerequisites

- **Node.js**: v18.0.0 or higher
- **Polymarket Account**: Funder address and API credentials
- **Anthropic API Key**: For Claude-powered market analysis
- **News API Key**: GNews (or TinyFish) for fetching real-time market context

## 📦 Installation

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Configure Environment Variables:
   Copy the example environment file and fill in your credentials:
   ```bash
   cp .env.example .env
   ```
   *Make sure to configure your `POLYMARKET_FUNDER_ADDRESS`, `ANTHROPIC_API_KEY`, and other required keys.*

## 🚦 Usage

### Start Live / Simulation Mode
Run the bot using npm:
```bash
npm start
```
*Note: To run safely without placing real trades, ensure your `.env` configuration sets the bot to **READ-ONLY** mode.*

### Development Mode
To run with automatic compilation/restarts on file changes:
```bash
npm run dev
```

---

## 📊 Dashboard Monitoring

Once started, the Polybot dashboard is accessible via your web browser:
- **UI Interface**: [http://localhost:3000](http://localhost:3000)
- **WebSocket Feed**: `ws://localhost:3001`

---

## ⚠️ Disclaimer

**Educational and Experimental Use Only**
This software is provided "as is" and is intended for educational purposes. Cryptocurrency and prediction market trading involves substantial risk of loss and is not suitable for every investor. The developers are not responsible for any financial losses incurred while using this bot.