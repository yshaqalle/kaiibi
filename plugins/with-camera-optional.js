const { withAndroidManifest } = require('expo/config-plugins');

// Declares the camera as OPTIONAL hardware on Android.
//
// Without this, adding the CAMERA permission quietly costs the app its
// distribution reach: Google Play infers `android.hardware.camera` with
// `required="true"` from the permission alone, and then hides the app from
// every device that has no camera. For a point-of-sale app that is precisely
// the wrong trade — a shop running the till on a camera-less tablet still
// wants the register, and simply won't use the scan button.
//
// expo-camera's own plugin adds the permission but not this declaration, so it
// has to be said explicitly.
const FEATURES = [
  // Any camera at all.
  { name: 'android.hardware.camera', required: 'false' },
  // Autofocus is listed separately by Android and is inferred the same way.
  { name: 'android.hardware.camera.autofocus', required: 'false' },
];

module.exports = function withCameraOptional(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const existing = manifest['uses-feature'] ?? [];

    for (const feature of FEATURES) {
      const already = existing.find((item) => item?.$?.['android:name'] === feature.name);
      if (already) {
        // Another plugin got here first. Force `false`: a single `true`
        // anywhere is what excludes the devices, so the looser value has to win
        // rather than be left to plugin ordering.
        already.$['android:required'] = feature.required;
      } else {
        existing.push({ $: { 'android:name': feature.name, 'android:required': feature.required } });
      }
    }

    manifest['uses-feature'] = existing;
    return cfg;
  });
};
