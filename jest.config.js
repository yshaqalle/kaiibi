// Pinned to a DST-observing zone rather than left to the CI host's default:
// the suite exercises calendar-day stepping around daylight-saving
// boundaries (see src/lib/pay-periods.ts and payroll-reporting.ts), and that
// logic is invisible in UTC, which never observes DST.
process.env.TZ = 'America/New_York';

module.exports = {
  preset: 'jest-expo',
  // react-native-reanimated 4's own module resolves worklets through
  // `.native.ts` files that reach for a real Turbo Module -- absent under
  // Jest, and the source of the `loadUnpackers` crash below. Its sibling
  // package ships a resolver made for exactly this: it strips the `native`
  // extension so the plain (JS-runtime) fallback resolves instead.
  resolver: 'react-native-worklets/jest/resolver.js',
  // Anchored to <rootDir>, not bare substrings. Unanchored, these are matched
  // against each test's ABSOLUTE path -- so a checkout living anywhere under a
  // directory called `.claude` (which is exactly where `.claude/worktrees/<name>`
  // puts one) had all 92 of its test files matched and then silently filtered
  // back out. Jest reported "No tests found" and exited 0-ish, which reads as a
  // clean baseline rather than a suite that never ran.
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/.expo/', '<rootDir>/.claude/'],
  // constants/theme.ts imports global.css for the web font variables, which
  // Jest cannot parse — so anything reading a colour token was untestable.
  // See jest/style-stub.js.
  //
  // AsyncStorage's native module isn't linked under Jest, so anything that
  // transitively imports it (use-auth.tsx) throws on require() unless it is
  // swapped for the in-memory mock the library ships for exactly this.
  //
  // react-native-reanimated's real entry point reaches for the native
  // Worklets module (`NativeWorklets.native.ts`) at import time, which has no
  // binding under Jest -- `Cannot read properties of undefined (reading
  // 'loadUnpackers')`. theme-shared.tsx started importing it for the hero's
  // entering animations, and that file is a transitive import of most of the
  // storefront suite, so every one of those tests died on require() rather
  // than on an assertion. The library ships `mock.js` for exactly this.
  moduleNameMapper: {
    '\\.(css)$': '<rootDir>/jest/style-stub.js',
    '^@/assets/.+\\.(png|jpg|jpeg|gif|webp|svg)$': '<rootDir>/jest/asset-stub.js',
    '^@react-native-async-storage/async-storage$': '@react-native-async-storage/async-storage/jest/async-storage-mock',
    '^react-native-reanimated$': '<rootDir>/jest/reanimated-mock.js',
  },
};
