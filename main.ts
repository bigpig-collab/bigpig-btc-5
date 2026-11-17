// Dip-buy mean reversion on CBBTC, 1-minute bars.
//
// The idea: after a sharp one-hour slide the tape is usually oversold, and
// the first uptick off the slide is a better entry than the slide itself.
// So the bot buys only when three things line up on the same bar:
//
//   1. the close is at least 1.00% below the close 60 bars ago (the dip),
//   2. the close is above the close 2 bars ago (the turn has started),
//   3. the bot is flat.
//
// It then rides the recovery with the whole stack and banks it at +1.80%
// over cost, or walks away after 480 bars if the recovery never comes.
// There is no stop-loss and no trailing stop on purpose: the recovery in
// this window takes 130-390 bars to mature and shakes out 1-2% several
// times on the way up, so a stop would only cut the winners short. The
// 480-bar cap is the only risk control.
//
// Everything is decided from bars the harness has already sent. No clock,
// no network, no files, no randomness: the same bars always give the same
// orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** Basis points in one unit, for the integer comparisons below. */
const BPS_DENOM = 10000n;

/** The single symbol this race trades. */
const SYMBOL = 'CBBTC';

/** How far back the dip is measured, in bars (60 minutes). */
const DIP_WINDOW = 60;
/** Minimum slide over the dip window, in basis points (1.00%). */
const DIP_MIN_BPS = 100n;
/** Recovery confirmation: close now must beat the close this many bars back. */
const CONFIRM_LAG = 2;
/** Take profit: position value must reach cost * (1 + 1.80%). */
const TAKE_PROFIT_BPS = 180n;
/** Time exit: give up after this many bars in the trade. */
const MAX_HOLD_BARS = 480;
/** Slippage cap on every order, in basis points (1%). */
const SLIPPAGE_BPS = 100;

/** Every close seen so far, oldest first, as raw price units. */
const closes: bigint[] = [];
/** Bars spent inside the current trade; reset whenever flat. */
let barsInTrade = 0;

/**
 * True when `current` sits at least `dropBps` below `reference`, computed
 * in integers so there is no floating-point drift: current/reference <
 * (10000 - dropBps) / 10000.
 */
function droppedByAtLeast(current: bigint, reference: bigint, dropBps: bigint): boolean {
  return current * BPS_DENOM < reference * (BPS_DENOM - dropBps);
}

/** True when the position is up at least `takeBps` over what it cost. */
function reachedTakeProfit(value: bigint, cost: bigint, takeBps: bigint): boolean {
  return value * BPS_DENOM >= cost * (BPS_DENOM + takeBps);
}

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    const position = state.positions.get(SYMBOL);
    if (position !== undefined && position.qty > 0n) {
      barsInTrade += 1;
      const value = state.value(SYMBOL, position.qty);
      const bankIt = reachedTakeProfit(value, position.cost, TAKE_PROFIT_BPS);
      const stale = barsInTrade >= MAX_HOLD_BARS;
      if (bankIt || stale) {
        barsInTrade = 0;
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: position.qty,
            max_slippage_bps: SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // Flat: wait for a dip that has started to turn.
    barsInTrade = 0;
    if (closes.length <= DIP_WINDOW) return [];
    const latest = closes[closes.length - 1];
    const hourAgo = closes[closes.length - 1 - DIP_WINDOW];
    if (!droppedByAtLeast(latest, hourAgo, DIP_MIN_BPS)) return [];
    const twoBarsAgo = closes[closes.length - 1 - CONFIRM_LAG];
    if (latest <= twoBarsAgo) return [];
    if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: SLIPPAGE_BPS,
      },
    ];
  },
});
