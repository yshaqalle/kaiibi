import { withSerializationRetry } from '@/lib/serialization-retry';

// A supabase-shaped result: { data, error }, where a serialization failure
// carries error.code === '40001'.
const ok = (data: unknown) => ({ data, error: null });
const failWith = (code: string) => ({ data: null, error: { code, message: code } });

// A `run` that returns a scripted sequence of results, one per call, and records
// how many times it was invoked. sleep is injected so no real time passes.
function scripted(sequence: { data: unknown; error: { code: string; message: string } | null }[]) {
  let calls = 0;
  const run = () => {
    const result = sequence[Math.min(calls, sequence.length - 1)];
    calls += 1;
    return Promise.resolve(result);
  };
  return { run, calls: () => calls };
}

describe('withSerializationRetry', () => {
  const noSleep = () => Promise.resolve();

  it('calls once and returns on success, without sleeping', async () => {
    const s = scripted([ok(6)]);
    let slept = 0;
    const out = await withSerializationRetry(s.run, { sleep: () => { slept += 1; return Promise.resolve(); } });
    expect(out).toEqual(ok(6));
    expect(s.calls()).toBe(1);
    // A success must not pay a retry's latency.
    expect(slept).toBe(0);
  });

  it('retries a 40001 and returns the eventual success', async () => {
    // Two serialization failures then a success -- the exact shape of a run that
    // raced a reversal twice and then found a clear window. The whole point of
    // the retry is that the user never sees the first two.
    const s = scripted([failWith('40001'), failWith('40001'), ok(6)]);
    const out = await withSerializationRetry(s.run, { maxAttempts: 4, sleep: noSleep });
    expect(out).toEqual(ok(6));
    expect(s.calls()).toBe(3);
  });

  it('gives up after maxAttempts and returns the 40001 rather than looping forever', async () => {
    // A persistent conflict is a real problem, not a transient one, and must
    // surface. The caller's `if (error) throw error` then shows it.
    const s = scripted([failWith('40001')]);
    const out = await withSerializationRetry(s.run, { maxAttempts: 3, sleep: noSleep });
    expect(out.error?.code).toBe('40001');
    expect(s.calls()).toBe(3);
  });

  it('does not retry a non-serialization error', async () => {
    // A permission error (P0001) or a validation error is not going to resolve
    // itself on a second attempt; retrying it only delays the message and
    // re-runs a call that already decided it would not proceed.
    const s = scripted([failWith('P0001'), ok(6)]);
    const out = await withSerializationRetry(s.run, { maxAttempts: 4, sleep: noSleep });
    expect(out.error?.code).toBe('P0001');
    expect(s.calls()).toBe(1);
  });

  it('backs off between attempts, and by more each time', async () => {
    // A fixed retry is a thundering herd of its own: two devices that both
    // raced will both retry on the same beat and race again. The delay grows so
    // successive collisions spread out.
    const s = scripted([failWith('40001'), failWith('40001'), ok(6)]);
    const delays: number[] = [];
    await withSerializationRetry(s.run, {
      maxAttempts: 4,
      sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
      // deterministic jitter so the assertion is stable
      random: () => 0.5,
    });
    expect(delays.length).toBe(2);
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });
});
