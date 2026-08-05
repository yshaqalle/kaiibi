// Pinned to a DST-observing zone rather than left to the CI host's default:
// the suite exercises calendar-day stepping around daylight-saving
// boundaries (see src/lib/pay-periods.ts and payroll-reporting.ts), and that
// logic is invisible in UTC, which never observes DST.
process.env.TZ = 'America/New_York';

module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/.claude/'],
  // constants/theme.ts imports global.css for the web font variables, which
  // Jest cannot parse — so anything reading a colour token was untestable.
  // See jest/style-stub.js.
  moduleNameMapper: {
    '\\.(css)$': '<rootDir>/jest/style-stub.js',
  },
};
