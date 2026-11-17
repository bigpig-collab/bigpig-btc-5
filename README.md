# bigpig-btc-5

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/bigpig-collab/bigpig-btc-5/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/bigpig-collab/bigpig-btc-5/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Dip-buy mean reversion on CBBTC for the make.fun BTC 24h race (2026-11-17). A long-only dip buyer on 1-minute CBBTC bars: it buys the whole stack when the close is at least 1.00% below the close 60 bars ago and the close has turned up above the close 2 bars ago, then banks the trade at +1.80% over cost or walks away after 480 bars. No stop-loss, no trailing stop, no cooldown — the recovery in this window takes hundreds of bars to mature, and the 480-bar cap is the only risk control. Every decision uses only bars the harness has already sent, so the bot is fully deterministic. Grade-local on the dev window: net PnL +$35.33, 5 trades, win rate 100%, max drawdown 0.72%.

## Run it

```sh
node main.ts
```

Grade it locally with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-entry> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wgthwqcw&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
