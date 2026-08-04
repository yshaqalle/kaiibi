// Pinned to a DST-observing zone rather than left to the CI host's default:
// the suite exercises calendar-day stepping around daylight-saving
// boundaries (see src/lib/pay-periods.ts and payroll-reporting.ts), and that
// logic is invisible in UTC, which never observes DST.
process.env.TZ = 'America/New_York';

// staff-import.ts pulls in @/lib/staff -> @/lib/supabase, which throws at
// import time without these and initializes an AsyncStorage-backed auth
// client that has no native module in the Jest environment. Neither value is
// ever used for a real network call in tests -- the client is only
// constructed, never invoked -- so placeholders are fine here.
process.env.EXPO_PUBLIC_SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'http://localhost:54321';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'test-anon-key';

module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/.claude/'],
  moduleNameMapper: {
    '^@react-native-async-storage/async-storage$': '@react-native-async-storage/async-storage/jest/async-storage-mock',
  },
};
