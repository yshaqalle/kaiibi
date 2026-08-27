// Run a block of assertions with the process pretending to be somewhere else.
//
// WHY THIS EXISTS. jest.config.js pins the whole suite to America/New_York, on
// purpose (DST-observing, so the pay-period logic is actually exercised). That
// pin means a test asserting anything about timezones proves one thing about
// one zone. For code whose entire claim is "this reads the same wherever the
// reader is", a test that never leaves the ambient zone is vacuous -- it would
// pass just as happily against the bug it is supposed to be catching.
//
// HOW IT WORKS, AND WHY NOT THE OBVIOUS WAY. Node honours `process.env.TZ`
// live -- assigning to it fires V8's timezone-change notification and every
// `Date` built afterwards reads the new zone -- but the `process` a Jest test
// file sees is a SANDBOXED copy whose `env` is a plain object with no setter.
// Setting it inside a test does nothing at all, silently. So the assignment is
// made by jest/timezone-environment.js, which the Jest runner loads outside
// the sandbox where `process` is the real one, and which hands the function in
// as `__setProcessTimezone`. A file using this helper MUST declare that
// environment in its docblock:
//
//   /**
//    * @jest-environment ../../../jest/timezone-environment.js
//    */
//
// Nothing here mocks Date. The runtime genuinely believes it is in `zone` for
// the duration of the callback.
//
// WHY IT ASSERTS THE SWITCH TOOK, TWICE OVER. A timezone switch that silently
// did nothing is exactly the failure this helper exists to rule out: every
// assertion inside would still run, still pass, and still be worthless. So a
// missing environment is an error rather than a no-op, and the zone is read
// back from the runtime and compared before the callback is allowed to run.
// Either way these tests fail by name, loudly, rather than quietly running
// America/New_York six times under six different labels.
//
// SCOPE. The zone is process-global, and Jest runs a worker's test files one
// after another rather than concurrently, so the restore in `finally` is what
// keeps a switch from leaking into the next file (the environment's teardown
// is the backstop). Keep the callback SYNCHRONOUS: an async body would return
// before the restore and leave the whole worker somewhere else.
type TimezoneGlobal = { __setProcessTimezone?: (zone: string | undefined) => void };

// Tracked here rather than read back from `process.env.TZ`, which inside the
// sandbox is a frozen-at-fork copy and would report the pinned zone even
// mid-switch -- so a nested call would "restore" to the wrong place.
let currentZone: string | undefined = process.env.TZ;

export function inTimezone<T>(zone: string, run: () => T): T {
  const setZone = (globalThis as TimezoneGlobal).__setProcessTimezone;
  if (!setZone) {
    throw new Error(
      'inTimezone needs the timezone test environment. Add to the top of the test file:\n'
      + '  /**\n   * @jest-environment ../../../jest/timezone-environment.js\n   */\n'
      + 'Without it, setting process.env.TZ inside a test is silently ignored and every '
      + 'assertion below would run in the suite\'s pinned zone instead.',
    );
  }

  const previous = currentZone;
  setZone(zone);
  currentZone = zone;
  try {
    const actual = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (actual !== zone) {
      throw new Error(
        `inTimezone('${zone}') did not take: the runtime still reports '${actual}'. `
        + 'Every assertion inside this block would have run in the wrong zone and proved nothing.',
      );
    }
    return run();
  } finally {
    setZone(previous);
    currentZone = previous;
  }
}

// The zones the customer-facing date tests sweep, and why each one is here.
//
// The bug being guarded against shifts the day only for readers on one side of
// the shop, so a list of "some zones" is not enough -- it has to straddle
// UTC+3 in both directions and include the shop itself:
//
//   Africa/Mogadishu   the shop, and nearly every shopkeeper: the answer every
//                      other zone has to agree with.
//   UTC                three hours behind the shop. Enough on its own to move
//                      a window stored at Mogadishu midnight back a day.
//   America/New_York   the suite's own pinned zone, and a diaspora city.
//   Pacific/Niue       UTC-11, the furthest behind.
//   Pacific/Kiritimati UTC+14, the furthest ahead -- the other side of the
//                      shop, so a fix that merely leaned the error the other
//                      way could not pass this list.
//   Australia/Lord_Howe a +10:30 half-hour offset, because an implementation
//                      that assumed whole-hour offsets would survive all of
//                      the above.
export const READER_ZONES = [
  'Africa/Mogadishu',
  'UTC',
  'America/New_York',
  'Pacific/Niue',
  'Pacific/Kiritimati',
  'Australia/Lord_Howe',
];
