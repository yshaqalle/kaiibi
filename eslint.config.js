// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // React Native's `Modal` defaults `supportedOrientations` to `['portrait']`,
    // so a modal opened on a device held in landscape force-rotates the whole
    // scene -- and enough of those in quick succession leave iOS with orientation
    // transactions that never commit, which suspends interaction and freezes the
    // screen. `AppModal` supplies the right value; this makes forgetting it a
    // lint error rather than a bug someone finds at a till.
    files: ["src/**/*.{ts,tsx}"],
    // The wrapper renders it; tests import it to assert on what the wrapper
    // passed. Neither is a screen that could freeze.
    ignores: ["src/components/ui/app-modal.tsx", "src/**/__tests__/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "react-native",
          importNames: ["Modal"],
          message: "Use AppModal from '@/components/ui/app-modal' instead. A bare Modal defaults to portrait-only and force-rotates the app in landscape.",
        }],
      }],
    },
  },
]);
