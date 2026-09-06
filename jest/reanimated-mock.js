// react-native-reanimated ships `mock.js` for exactly this file's job, but its
// own source (`src/mock.ts`) leaves `useReducedMotion` out with a comment
// reading "ADD ME IF NEEDED" -- ShopAnchor (theme-shared.tsx) is this repo's
// first caller, so it is needed. This wraps the real mock and adds it.
//
// Reduced motion defaults to off under test, matching what a device with no
// accessibility setting changed reports -- so the ordinary suite exercises
// the animated branch, and a test for the reduced-motion branch overrides
// this one module for itself with `jest.mock('react-native-reanimated', ...)`.
const Reanimated = require('react-native-reanimated/mock');

module.exports = {
  ...Reanimated,
  useReducedMotion: () => false,
};
