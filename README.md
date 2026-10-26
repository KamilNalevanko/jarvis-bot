# J.A.R.V.I.S. server bot

Runs every 15 minutes on GitHub Actions (free for public repositories), 24/7 even when your PC is off.

Each run:
1. settles open demo trades with 5-minute candles since the last run,
2. scans the 30 most traded Hyperliquid perps on 4h and 1h with the same engine as the app (`index.html`),
3. opens TRADE IT setups (4h only, score ≥ 9, daily trend on the same side, ADX ≥ 20, R:R ≥ 2, max 3 open and max 2 in one direction, 1 % risk, 24 h pause on a coin after its stop, daily stop 3 %); exits: 50 % at TP1 and stop to entry, rest at TP2,
4. mirrors each trade to your **Hyperliquid TESTNET** account (2 limit entries, each with exchange-side SL and TP),
5. saves `state.json` (for the app) and `REPORT.md` (readable here on GitHub).

Orders can only go to `api.hyperliquid-testnet.xyz`. There is no mainnet code path in the bot.

Telegram: with secrets `TG_TOKEN` and `TG_CHAT` the bot messages you about new calls, filled entries, TP1, closes and a daily summary.

Settings live in `config.json`. Secrets (`HL_ADDR`, `HL_KEY`, `TG_TOKEN`, `TG_CHAT`) live in GitHub → Settings → Secrets and variables → Actions and are never visible in the repository.
