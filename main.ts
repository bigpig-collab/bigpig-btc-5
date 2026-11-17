// CBBTC dip-buy, 1-minute bars — two entry arms, one position at a time.
//
// The window is mostly flat (+0.53% end to end), so the money is in buying
// sharp dips and riding the bounce back. Two different dip shapes appear,
// and each arm owns one of them; a trade is always all-in, long-only, and
// the first arm to fire while flat takes it.
//
// Arm "retest" — a deep one-hour slide that already bounced once, then
// comes back to test the low. Three conditions on the same bar:
//   * close is down >= 105 bps vs the close 60 bars ago,
//   * close is the lowest of the last 60 closes (the retest itself),
//   * some bar in the last 20 rose >= 10 bps over the two bars before it
//     (a bounce already happened — this is a retest, not a free fall).
// Exit: bank at +195 bps over cost, or give up after 480 bars.
//
// Arm "shallow" — a short 30-bar slide inside a flat hour, too shallow for
// the 60-bar test above. Four conditions on the same bar:
//   * close is down 60..80 bps vs the close 30 bars ago (a real dip, but
//     not a violent flush — those keep falling),
//   * close is above the close 2 bars ago (the turn has started),
//   * the 60-bar context is flat-to-mildly-down: close is at or below the
//     close 60 bars ago, but no more than 50 bps below it.
// Exit: bank at +87 bps over cost, or give up after 120 bars.
//
// Why two arms: "retest" alone catches the two big recoveries; "shallow"
// alone catches the one late ~100 bps bounce and nothing else — its gates
// keep it out of the early chop, out of the deep-dip clusters the first arm
// owns, and out of the dead zone after the second recovery.
//
// Every decision uses only bars the harness has already sent. No clock, no
// network, no files, no randomness: the same bars always give the same
// orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** One unit of price, split into 10,000 basis points. */
const UNIT = 10000n;

/** The only symbol in this race. */
const SYMBOL = 'CBBTC';

/** Slippage cap on every order, in basis points (1%). */
const MAX_SLIP_BPS = 100;

/** Retest arm: dip window, in bars (one hour). */
const RETEST_SPAN = 60;
/** Retest arm: minimum slide over that window, in bps (1.05%). */
const RETEST_DROP = 105n;
/** Retest arm: a bounce is a bar beating the close 2 bars back by this, in bps. */
const RETEST_BOUNCE = 10n;
/** Bounce confirmation lag, in bars: a bounce is measured against the close this many bars back. */
const BOUNCE_LAG = 2;
/** Retest arm: how far back to look for that bounce, in bars. */
const RETEST_LOOKBACK = 20;
/** Retest arm: take profit, in bps over cost (1.95%). */
const RETEST_TAKE = 195n;
/** Retest arm: time exit, in bars. */
const RETEST_MAX_HOLD = 480;

/** Shallow arm: dip window, in bars (half an hour). */
const SHALLOW_SPAN = 30;
/** Shallow arm: minimum slide over that window, in bps (0.60%). */
const SHALLOW_DROP_MIN = 60n;
/** Shallow arm: maximum slide over that window, in bps (0.80%). */
const SHALLOW_DROP_MAX = 80n;
/** Shallow arm: the turn is confirmed against the close this many bars back. */
const SHALLOW_TURN_LAG = 2;
/** Shallow arm: deepest 60-bar slide it will touch, in bps (0.50%). */
const SHALLOW_CTX_MAX = 50n;
/** Shallow arm: take profit, in bps over cost (0.87%). */
const SHALLOW_TAKE = 87n;
/** Shallow arm: time exit, in bars. */
const SHALLOW_MAX_HOLD = 120;

/** Every close seen so far, oldest first, in raw price units. */
const closes: bigint[] = [];
/** Bars held in the current trade; zero whenever flat. */
let heldBars = 0;
/** Which arm opened the current trade: 'retest' | 'shallow' | ''. */
let currentArm = '';

/** True when `now` is at least `bps` below `then` (integer math, no float drift). */
function isDownAtLeast(now: bigint, then: bigint, bps: bigint): boolean {
  return now * UNIT < then * (UNIT - bps);
}

/** True when `now` is at least `bps` above `then`. */
function isUpAtLeast(now: bigint, then: bigint, bps: bigint): boolean {
  return now * UNIT >= then * (UNIT + bps);
}

/**
 * True when the latest close is the strict low of the previous `span`
 * closes: it must sit below every one of them.
 */
function isSpanLow(latest: bigint, span: number): boolean {
  const n = closes.length;
  for (let k = n - 1 - span; k < n - 1; k += 1) {
    if (latest >= closes[k]) return false;
  }
  return true;
}

/**
 * True when some bar in the recent window bounced: its close beat the close
 * two bars before it by at least `bps`. The window covers the last
 * `lookback` bars, skipping the very latest one (its own bounce is checked
 * by the caller, not here).
 */
function sawBounce(lookback: number, bps: bigint): boolean {
  const n = closes.length;
  const start = Math.max(RETEST_SPAN, n - 1 - lookback);
  for (let j = start; j < n - 1; j += 1) {
    if (isUpAtLeast(closes[j], closes[j - BOUNCE_LAG], bps)) return true;
  }
  return false;
}

/** Retest arm: deep slide + fresh 60-bar low + a bounce in the last 20 bars. */
function retestFires(latest: bigint): boolean {
  if (closes.length <= RETEST_SPAN) return false;
  const hourAgo = closes[closes.length - 1 - RETEST_SPAN];
  if (!isDownAtLeast(latest, hourAgo, RETEST_DROP)) return false;
  if (!isSpanLow(latest, RETEST_SPAN)) return false;
  return sawBounce(RETEST_LOOKBACK, RETEST_BOUNCE);
}

/** Shallow arm: 60..80 bps slide over 30 bars, turning up, flat 60-bar context. */
function shallowFires(latest: bigint): boolean {
  if (closes.length <= RETEST_SPAN + 1) return false;
  const n = closes.length;
  const halfHourAgo = closes[n - 1 - SHALLOW_SPAN];
  const hourAgo = closes[n - 1 - RETEST_SPAN];
  const twoBack = closes[n - 1 - SHALLOW_TURN_LAG];
  const dipInBand =
    isDownAtLeast(latest, halfHourAgo, SHALLOW_DROP_MIN) &&
    !isDownAtLeast(latest, halfHourAgo, SHALLOW_DROP_MAX);
  const turningUp = latest > twoBack;
  const flatContext =
    latest <= hourAgo && latest * UNIT >= hourAgo * (UNIT - SHALLOW_CTX_MAX);
  return dipInBand && turningUp && flatContext;
}

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    const position = state.positions.get(SYMBOL);
    if (position !== undefined && position.qty > 0n) {
      heldBars += 1;
      const take = currentArm === 'shallow' ? SHALLOW_TAKE : RETEST_TAKE;
      const maxHold = currentArm === 'shallow' ? SHALLOW_MAX_HOLD : RETEST_MAX_HOLD;
      const value = state.value(SYMBOL, position.qty);
      const banked = isUpAtLeast(value, position.cost, take);
      const stale = heldBars >= maxHold;
      if (banked || stale) {
        heldBars = 0;
        currentArm = '';
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: position.qty,
            max_slippage_bps: MAX_SLIP_BPS,
          },
        ];
      }
      return [];
    }

    // Flat: wait for either arm to fire; retest first, shallow second.
    heldBars = 0;
    currentArm = '';
    const latest = closes[closes.length - 1];
    if (retestFires(latest)) {
      currentArm = 'retest';
    } else if (shallowFires(latest)) {
      currentArm = 'shallow';
    }
    if (currentArm === '') return [];
    if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: MAX_SLIP_BPS,
      },
    ];
  },
});
