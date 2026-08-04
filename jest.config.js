// Pinned to a DST-observing zone rather than left to the CI host's default:
// the suite exercises calendar-day stepping around daylight-saving
// boundaries (see src/lib/pay-periods.ts and payroll-reporting.ts), and that
// logic is invisible in UTC, which never observes DST.
process.env.TZ = 'America/New_York';

module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/.claude/'],
};
