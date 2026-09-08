// The latch that makes Enter safe on a form.
//
// Every submit in this app already had a `submitting` / `saving` / `busy` piece
// of state, and for a BUTTON that is enough: a greyed-out button cannot be
// pressed. The return key is not a button — a held Enter repeats every few dozen
// milliseconds, and React has not necessarily re-rendered between two of those,
// so both calls read the same stale `false`. These tests hold the difference:
// the refusal is synchronous, at the moment of the call, with no render in
// between.

import { act, create } from 'react-test-renderer';

import { useSingleFlight } from '@/hooks/use-single-flight';

// A component is the only place a hook can live. It hands the wrapped function
// straight back out so a test can call it the way a keypress would.
function harness<A extends unknown[]>(run: (...args: A) => Promise<void> | void) {
  const captured: { call: (...args: A) => Promise<void> } = { call: async () => {} };
  function Harness() {
    captured.call = useSingleFlight(run);
    return null;
  }
  act(() => {
    create(<Harness />);
  });
  return captured;
}

// A promise this test resolves by hand, so "still in flight" is a state the
// assertions can sit inside rather than race against.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it('refuses a second call while the first is still in flight', async () => {
  const gate = deferred();
  const run = jest.fn(() => gate.promise);
  const { call } = harness(run);

  // Both presses land in one tick — no render between them, which is exactly
  // what a held return key produces and what a state flag cannot catch.
  void call();
  void call();
  expect(run).toHaveBeenCalledTimes(1);

  await act(async () => {
    gate.resolve();
    await gate.promise;
  });

  expect(run).toHaveBeenCalledTimes(1);
});

it('allows the next call once the first has settled', async () => {
  const run = jest.fn(async () => {});
  const { call } = harness(run);

  await act(async () => {
    await call();
  });
  await act(async () => {
    await call();
  });

  expect(run).toHaveBeenCalledTimes(2);
});

it('releases the latch when the wrapped function throws', async () => {
  const run = jest.fn(async () => {
    throw new Error('network');
  });
  const { call } = harness(run);

  // A failed save has to be retryable — a latch that stuck on the error would
  // leave the form permanently unsubmittable, which is worse than the duplicate
  // it exists to prevent.
  await act(async () => {
    await expect(call()).rejects.toThrow('network');
  });
  await act(async () => {
    await expect(call()).rejects.toThrow('network');
  });

  expect(run).toHaveBeenCalledTimes(2);
});

it('passes its arguments through untouched', async () => {
  const run = jest.fn(async (_a: string, _b: number) => {});
  const { call } = harness(run);

  await act(async () => {
    await call('slsh', 115);
  });

  expect(run).toHaveBeenCalledWith('slsh', 115);
});
