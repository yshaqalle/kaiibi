// Retry a database call that lost a race, and only that.
//
// WHAT RAISES 40001 HERE, AND WHY RETRYING IS CORRECT. `run_depreciation`
// (20261008000000) takes a per-shop advisory lock and then asserts, for every
// month it posts, that the charge rows it actually WROTE sum to what the entry
// it posted CREDITED to 1590 -- and `raise ... using errcode = '40001'` if they
// disagree. That disagreement is what a concurrent door which does NOT take the
// shop lock produces: `reverse_journal_entry` is the shipped example, because it
// cannot take the lock without inverting the order against post_journal_entry's
// counter and deadlocking. The 40001 is deliberate: the run rolls the whole
// transaction back rather than commit a ledger and a register that disagree.
//
// A serialization failure is the one error class it is SAFE to retry blindly,
// and the safety is structural, not a hope:
//
//   1. 40001 aborts and rolls back the ENTIRE transaction. Nothing committed,
//      so a retry starts from the same state the first attempt saw -- there is
//      no half-done work to double-apply.
//   2. The operation must be IDEMPOTENT on replay, and run_depreciation is: its
//      own docstring promises "running it twice for the same month writes
//      nothing and returns 0". A retry either finds the window clear and does
//      the work, or finds it already done and returns 0.
//
// Both halves are required. This helper must NOT be wrapped around an operation
// that commits partial work before it can fail, nor around one whose replay
// would double-apply -- for those, a 40001 is not a free retry and this is the
// wrong tool. It exists for RPCs that are a single transaction and idempotent,
// which is the family run_depreciation belongs to.
//
// DELIBERATELY 40001 ONLY, not 40P01 (deadlock_detected). The four fixed-asset
// doors take the shop lock FIRST and post_journal_entry's counter SECOND, in
// one order, so 20261008000000 argues there is no cycle and no deadlock. A
// 40P01 appearing would mean that ordering has regressed -- a real bug to
// surface loudly, not a transient to paper over. So it is left to throw.
//
// No Supabase import on purpose: this file is unit-tested, and importing the
// client would drag the native runtime in, the same split report-math draws
// from reports.

const SERIALIZATION_FAILURE = '40001';

/** The supabase-js result shape this retries over: success or a coded error. */
export type SupabaseResult<T> = { data: T | null; error: { code?: string | null; message?: string } | null };

export type RetryOptions = {
  /** Total tries, including the first. 4 means one attempt and up to three retries. */
  maxAttempts?: number;
  /** Base backoff in ms; the wait grows with each attempt. */
  baseDelayMs?: number;
  /** Injected so tests pass no real time; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so tests get deterministic jitter; defaults to Math.random. */
  random?: () => number;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, and if it comes back with a 40001 serialization failure, run
 * it again after a growing, jittered backoff -- up to `maxAttempts` times.
 *
 * Returns the LAST result rather than throwing, so the caller keeps its own
 * `if (error) throw error` and nothing about how errors are surfaced changes:
 * a success returns immediately, a persistent 40001 returns the error after the
 * last try, and any other error returns on the first try, unretried.
 *
 * The backoff grows (`baseDelayMs * 2^n`) with a half-to-full jitter, because a
 * fixed delay is a thundering herd of its own -- two devices that raced would
 * both wait the same beat and race again on the same beat.
 */
export async function withSerializationRetry<T>(
  attempt: () => Promise<SupabaseResult<T>>,
  options: RetryOptions = {}
): Promise<SupabaseResult<T>> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  let result = await attempt();
  for (let n = 1; n < maxAttempts; n += 1) {
    if (result.error?.code !== SERIALIZATION_FAILURE) return result;
    // Full jitter over an exponentially growing window: wait somewhere in
    // [base*2^(n-1)/2, base*2^(n-1)]. n starts at 1 so the first retry already
    // waits a real interval.
    const window = baseDelayMs * 2 ** (n - 1);
    await sleep(window * (0.5 + 0.5 * random()));
    result = await attempt();
  }
  return result;
}
