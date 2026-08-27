const { TestEnvironment: NodeEnvironment } = require('jest-environment-node');

// A test environment that can actually move the clock's timezone.
//
// WHY THIS FILE HAS TO EXIST. `process.env.TZ = 'Pacific/Kiritimati'` works in
// plain Node: assigning to it goes through Node's own setter, which fires
// V8's timezone-change notification, and every `Date` and `Intl` object built
// afterwards reads the new zone. It does NOTHING inside a Jest test. Jest
// hands each test file a SANDBOXED `process` whose `env` is a plain copied
// object -- no setter, no notification -- so the assignment lands in a
// dictionary nobody reads and the runtime stays exactly where it was.
//
// That failure is silent, which is the dangerous part. A test that sets TZ,
// believes it, and asserts a date is not a weak test; it is a test that ran in
// the suite's ambient zone under another zone's name, and it would pass
// against the very bug it was written to catch.
//
// A test environment module is loaded by the Jest RUNNER, not by the sandbox,
// so `process` in this file is the real one. The environment exposes a single
// function into the sandbox that assigns through it, which is the whole trick.
// See jest/timezone.ts for the helper tests actually call, and
// src/lib/__tests__/poster-timezone.test.ts for what needs it.

// Whatever the run was pinned to (jest.config.js pins America/New_York, for
// the DST-sensitive pay-period tests). Captured before anything moves it, and
// restored on teardown so a file that switches zones cannot leave the worker
// -- and therefore every test file scheduled after it -- somewhere else.
const PINNED_TZ = process.env.TZ;

function setProcessTimezone(zone) {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
}

class TimezoneEnvironment extends NodeEnvironment {
  async setup() {
    await super.setup();
    this.global.__setProcessTimezone = setProcessTimezone;
  }

  async teardown() {
    setProcessTimezone(PINNED_TZ);
    await super.teardown();
  }
}

module.exports = TimezoneEnvironment;
