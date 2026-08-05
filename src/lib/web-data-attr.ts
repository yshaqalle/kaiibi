import { Platform } from 'react-native';

// Tags a View with `data-kaiibi="<name>"` so a rule in global.css can reach it.
//
// react-native-web accepts a `dataSet` prop on any host component and renders
// each entry as a `data-*` attribute; React Native's own `ViewProps` has no
// such prop, so using it needs a cast. Doing it here means exactly one cast
// exists rather than one per call site.
//
// Only for the handful of things RN styles genuinely cannot express — the
// landing hero's radial gradients and the nav's backdrop blur. Anything
// expressible as a StyleSheet rule belongs in a StyleSheet, where native gets
// it too.
export function webDataAttr(name: string): object {
  if (Platform.OS !== 'web') return {};
  return { dataSet: { kaiibi: name } };
}
