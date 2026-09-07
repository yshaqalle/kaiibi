// react-native-reanimated ships `mock.js` for exactly this file's job, but its
// own source (`src/mock.ts`) leaves `useReducedMotion` out with a comment
// reading "ADD ME IF NEEDED" -- ShopAnchor (theme-shared.tsx) is this repo's
// first caller, so it is needed. This wraps the real mock and adds it.
//
// Reduced motion defaults to off under test, matching what a device with no
// accessibility setting changed reports.
//
// This mock also renders `Animated.View` as a plain `View` and discards the
// `entering` prop entirely (see the shipped `mock.ts`'s own `View: ViewRN`) --
// so no test can tell an animation that played from one that didn't by
// rendering through it, in either the reduced-motion state or the ordinary
// one. That is why the rise's decision (heroRiseDelay, heroHasRisen,
// markHeroRisen, resetHeroRisenForTests in theme-shared.tsx) is a plain
// function tested directly, never inferred from a render through this mock.
const Reanimated = require('react-native-reanimated/mock');

module.exports = {
  ...Reanimated,
  useReducedMotion: () => false,
};
