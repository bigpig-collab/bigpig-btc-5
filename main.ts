import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const UNIT = 10000n;
const SYMBOL = 'CBBTC';
const MAX_SLIP_BPS = 100;

// --- Arm parameters (all thresholds in basis points, integer math only) ---
// RETEST: deep 60-bar dip to a fresh 60-bar low, with a small bounce in the
// recent window confirming buyers stepped in at the low.
const RETEST_SPAN = 60;
const RETEST_DROP = 105n;
const RETEST_BOUNCE = 10n;
const RETEST_BOUNCE_LAG = 2;
const RETEST_LOOKBACK = 20;
const RETEST_TAKE = 198n;
const RETEST_MAX_HOLD = 480;

// SHALLOW: a moderate 30-bar dip (60-80 bps, not deeper) that already turned
// up, inside a flat 60-bar context (no bigger trend move behind it).
const SHALLOW_SPAN = 30;
const SHALLOW_DROP_MIN = 60n;
const SHALLOW_DROP_MAX = 80n;
const SHALLOW_TURN_LAG = 2;
const SHALLOW_CTX_MAX = 50n;
const SHALLOW_TAKE = 87n;
const SHALLOW_MAX_HOLD = 120;

// DEEP80: a very deep 80-bar drop on its own, no further confirmation.
const DEEP80_SPAN = 80;
const DEEP80_DROP = 125n;
const DEEP80_TAKE = 70n;
const DEEP80_MAX_HOLD = 150;

// --- State (one position at a time, long-only, all-in) ---
const closes: bigint[] = [];
let heldBars = 0;
let currentArm = '';
let tradesDone = 0;
let lastExitArm = '';
let breakoutDone = 0;
let peakValue = 0n;

// --- Integer helpers (no floats anywhere) ---
function isDownAtLeast(now: bigint, then: bigint, bps: bigint): boolean {
  return now * UNIT < then * (UNIT - bps);
}

function isUpAtLeast(now: bigint, then: bigint, bps: bigint): boolean {
  return now * UNIT >= then * (UNIT + bps);
}

// True when `latest` is strictly below every one of the `span` closes
// immediately before the last bar.
function isSpanLow(latest: bigint, span: number): boolean {
  const n = closes.length;
  for (let k = n - 1 - span; k <= n - 2; k++) {
    if (!(latest < closes[k]!)) return false;
  }
  return true;
}

// True when some bar j in [max(60, n-1-lookback), n-1) closed up at least
// `bps` versus the close 2 bars before bar j.
function sawBounce(lookback: number, bps: bigint): boolean {
  const n = closes.length;
  const start = Math.max(60, n - 1 - lookback);
  for (let j = start; j <= n - 2; j++) {
    if (isUpAtLeast(closes[j]!, closes[j - 2]!, bps)) return true;
  }
  return false;
}

// --- Arm: RETEST ---
function fireRetest(latest: bigint): boolean {
  const n = closes.length;
  if (n <= RETEST_SPAN) return false;
  if (!isDownAtLeast(latest, closes[n - 1 - RETEST_SPAN]!, RETEST_DROP)) return false;
  if (!isSpanLow(latest, RETEST_SPAN)) return false;
  if (!sawBounce(RETEST_LOOKBACK, RETEST_BOUNCE)) return false;
  return true;
}

// --- Arm: SHALLOW ---
function fireShallow(latest: bigint): boolean {
  const n = closes.length;
  if (n <= RETEST_SPAN) return false;
  const ref30 = closes[n - 1 - SHALLOW_SPAN]!;
  if (!isDownAtLeast(latest, ref30, SHALLOW_DROP_MIN)) return false;
  if (isDownAtLeast(latest, ref30, SHALLOW_DROP_MAX)) return false;
  if (!(latest > closes[n - 1 - SHALLOW_TURN_LAG]!)) return false;
  const ref60 = closes[n - 1 - RETEST_SPAN]!;
  if (!(latest <= ref60)) return false;
  if (isDownAtLeast(latest, ref60, SHALLOW_CTX_MAX)) return false;
  return true;
}

// --- Arm: DEEP80 ---
function fireDeep80(latest: bigint): boolean {
  const n = closes.length;
  if (n <= DEEP80_SPAN) return false;
  return isDownAtLeast(latest, closes[n - 1 - DEEP80_SPAN]!, DEEP80_DROP);
}

// --- Arm: BREAKOUT ---
// Why this arm exists: the dip arms only fire after a fall, so they miss the
// window's opening leg, where price grinds up out of a tight 30-bar range
// before any dip has formed. It therefore fires only once, only early
// (bar < 150), and only when the close both breaks the prior 20-bar high by
// >=7 bps and is still rising (+10 bps vs 2 bars ago) out of a range no
// wider than 60 bps — a genuine breakout, not a drift through a wide chop.
// --- Arm: LATELEG ---
// Why this arm exists: after a retest trade has completed, the same deep
// 60-bar dip shape often repeats as a second leg while the move is still
// alive. It re-uses the retest drop (105 bps) but needs only a small
// +7 bps turn (no fresh-low / bounce-window proof) and takes a quick
// +30 bps, because by then the easy part of the move is already banked.
const BREAKOUT_SPAN = 20;
const BREAKOUT_MARGIN = 7n;
const BREAKOUT_MOMENTUM = 10n;
const BREAKOUT_MAX_BAR = 150;
const BREAKOUT_RANGE_MAX = 60n;
const BREAKOUT_RANGE_SPAN = 30;
const BREAKOUT_TAKE = 65n;
const BREAKOUT_MAX_HOLD = 90;

function fireBreakout(latest: bigint): boolean {
  const n = closes.length;
  if (!(n - 1 < BREAKOUT_MAX_BAR)) return false;
  if (!(breakoutDone === 0)) return false;
  if (!(n > BREAKOUT_SPAN)) return false;
  let high = closes[n - 1 - BREAKOUT_SPAN]!;
  for (let k = n - BREAKOUT_SPAN; k <= n - 2; k++) {
    if (closes[k]! > high) high = closes[k]!;
  }
  if (!isUpAtLeast(latest, high, BREAKOUT_MARGIN)) return false;
  if (!isUpAtLeast(latest, closes[n - 1 - 2]!, BREAKOUT_MOMENTUM)) return false;
  let lo = closes[Math.max(0, n - 1 - BREAKOUT_RANGE_SPAN)]!;
  let hi = lo;
  for (let k = Math.max(0, n - 1 - BREAKOUT_RANGE_SPAN); k <= n - 1; k++) {
    if (closes[k]! < lo) lo = closes[k]!;
    if (closes[k]! > hi) hi = closes[k]!;
  }
  if (!(hi * UNIT <= lo * (UNIT + BREAKOUT_RANGE_MAX))) return false;
  return true;
}

// --- Arm: LATELEG ---
const LATELEG_SPAN = 60;
const LATELEG_DROP = 105n;
const LATELEG_TURN_LAG = 2;
const LATELEG_BOUNCE = 7n;
const LATELEG_TAKE = 30n;
const LATELEG_MAX_HOLD = 90;

function fireLateleg(latest: bigint): boolean {
  const n = closes.length;
  if (!(tradesDone >= 2)) return false;
  if (!(lastExitArm === 'retest')) return false;
  if (!(closes.length > LATELEG_SPAN)) return false;
  if (!isDownAtLeast(latest, closes[n - 1 - LATELEG_SPAN]!, LATELEG_DROP)) return false;
  if (!isUpAtLeast(latest, closes[n - 1 - LATELEG_TURN_LAG]!, LATELEG_BOUNCE)) return false;
  return true;
}

// --- Exit parameters per arm ---
function exitParams(arm: string): { take: bigint; maxHold: number } {
  if (arm === 'shallow') return { take: SHALLOW_TAKE, maxHold: SHALLOW_MAX_HOLD };
  if (arm === 'deep80') return { take: DEEP80_TAKE, maxHold: DEEP80_MAX_HOLD };
  if (arm === 'breakout') return { take: BREAKOUT_TAKE, maxHold: BREAKOUT_MAX_HOLD };
  if (arm === 'lateleg') return { take: LATELEG_TAKE, maxHold: LATELEG_MAX_HOLD };
  return { take: RETEST_TAKE, maxHold: RETEST_MAX_HOLD };
}

// --- Main loop ---
await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;
    const cost = pos?.cost ?? 0n;

    if (qty > 0n) {
      heldBars++;
      const { take, maxHold } = exitParams(currentArm);
      const value = state.value(SYMBOL, qty);
      if (value > peakValue) peakValue = value;
      const banked = isUpAtLeast(value, cost, take);
      const stale = heldBars >= maxHold;
      const trailed =
        isUpAtLeast(peakValue, cost, 180n) && value * UNIT < peakValue * (UNIT - 30n);
      if (banked || stale || trailed) {
        heldBars = 0;
        peakValue = 0n;
        if (currentArm === 'breakout') breakoutDone++;
        lastExitArm = currentArm;
        tradesDone++;
        currentArm = '';
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP_BPS }];
      }
      return [];
    }

    heldBars = 0;
    currentArm = '';
    peakValue = 0n;
    const latest = closes[closes.length - 1]!;

    let arm = '';
    if (fireRetest(latest)) arm = 'retest';
    else if (fireShallow(latest)) arm = 'shallow';
    else if (fireDeep80(latest)) arm = 'deep80';
    else if (fireBreakout(latest)) arm = 'breakout';
    else if (fireLateleg(latest)) arm = 'lateleg';

    if (arm !== '' && state.cash >= BigInt(state.hello.fees.min_notional_quote_units)) {
      currentArm = arm;
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIP_BPS,
        },
      ];
    }
    return [];
  },
});
