import { useEffect, useRef, useState } from 'react';
import { PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { contrastRatio, inkFor, parseHex, stepUntilContrast } from '@/lib/contrast';

const theme = Colors.light;

// Six presets, taken straight from the design mockup's own swatch row
// (docs/design/promotion-poster-mockup.html, `.swatches`). These are
// candidate BRAND colours offered to a shop, not screen chrome -- a picker
// whose whole job is handing back a hex has to show the actual colours on
// offer, so this is the one place in this file (besides poster-canvas.tsx,
// the documented exception) a literal hex belongs. Every OTHER colour below
// -- borders, backgrounds, text -- reads `theme.bento*`.
const PRESETS = ['#5b31b5', '#0b6b3c', '#1b47b8', '#c0392b', '#c8791a', '#0b0b0d'];

// The same near-black poster-canvas.tsx fixes as its Bold template's ground
// (BOLD_GROUND there) -- duplicated here as colour DATA rather than imported,
// the same reasoning PRESETS above documents for itself: this is a
// general-purpose picker with no business knowing about poster templates.
// Used only to decide whether the quiet line below has anything to say; the
// poster itself still does its own per-template step against its own ground.
const DARK_TEMPLATE_GROUND = '#0b0b0d';

type Hsl = { h: number; s: number; l: number };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function toHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

function hueToRgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToHex({ h, s, l }: Hsl): string {
  const hn = (((h % 360) + 360) % 360) / 360;
  const sn = clamp01(s / 100);
  const ln = clamp01(l / 100);
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return toHex({ r: v, g: v, b: v });
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  return toHex({
    r: hueToRgb(p, q, hn + 1 / 3) * 255,
    g: hueToRgb(p, q, hn) * 255,
    b: hueToRgb(p, q, hn - 1 / 3) * 255,
  });
}

// Track fills, each a strip of flex-equal Views rather than a CSS gradient --
// there is no gradient primitive available without a new dependency, and this
// is the same "many thin swatches read as a ramp" trick the preset row itself
// uses, just denser. Every value in every stop is COMPUTED from the current
// hue/saturation/lightness, never a second literal palette.
const HUE_STEPS = 12;
const RAMP_STEPS = 8;

function hueTrack(): string[] {
  return Array.from({ length: HUE_STEPS }, (_, i) => hslToHex({ h: (360 * i) / (HUE_STEPS - 1), s: 85, l: 55 }));
}

function satTrack(h: number, l: number): string[] {
  return Array.from({ length: RAMP_STEPS }, (_, i) => hslToHex({ h, s: (100 * i) / (RAMP_STEPS - 1), l }));
}

function lightTrack(h: number, s: number): string[] {
  return Array.from({ length: RAMP_STEPS }, (_, i) => hslToHex({ h, s, l: (100 * i) / (RAMP_STEPS - 1) }));
}

// Six presets, a hex field, and three sliders (hue/saturation/lightness) built
// from plain Views and PanResponder -- no new dependency, and easier to hit on
// a counter tablet than a wheel. Reports through `onChange(hex)` and shows the
// resulting ink (`inkFor`) with its contrast ratio beside the swatch, so the
// owner sees the consequence of a pick before it goes to print, not after.
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [hsl, setHsl] = useState<Hsl>(() => {
    const rgb = parseHex(value);
    return rgb ? rgbToHsl(rgb) : { h: 255, s: 50, l: 40 };
  });
  const [hexInput, setHexInput] = useState(value);

  // Re-syncs from a change that came from OUTSIDE this component -- a preset
  // tap, the hex field, the web colour input, or a different promotion's
  // saved colour arriving as a new `value` prop. A slider drag's own onChange
  // always reports exactly `hslToHex(hsl)`, so that case is a no-op here --
  // if this resynced on every render mid-drag, the sliders would fight the
  // finger dragging them.
  // Deliberate "adjust state on a prop change" effect (one of the few uses
  // React's own docs endorse), not a synchronization loop: it only ever fires
  // for the OUTSIDE-change case explained above, which is inherently rare
  // (a pick, not a drag) -- there is no cheaper way to derive local slider
  // state from an incoming hex prop without recomputing HSL every render.
  useEffect(() => {
    if (hslToHex(hsl).toLowerCase() === value.toLowerCase()) return;
    const rgb = parseHex(value);
    if (rgb) setHsl(rgbToHsl(rgb));
  }, [value]);

  // Same reasoning as above, for the hex text field's own displayed value --
  // but compared by PARSED colour, not by string. Typing "abc" (a valid
  // 3-digit shorthand) fires `submitHex` and reports "#aabbcc" upward before
  // the 4th and 5th characters are even typed; syncing on string equality
  // would snap the field from "abc" to "#aabbcc" out from under the next
  // keystroke. Comparing the colours instead treats "abc" as already in sync
  // with an incoming "#aabbcc" and leaves the partial text alone.
  useEffect(() => {
    const current = parseHex(hexInput);
    const incoming = parseHex(value);
    if (current && incoming && current.r === incoming.r && current.g === incoming.g && current.b === incoming.b) return;
    setHexInput(value);
  }, [value]);

  const setFromHsl = (next: Hsl) => {
    setHsl(next);
    onChange(hslToHex(next));
  };

  // Goes straight from the typed hex to the reported colour, never through the
  // HSL round trip -- rgb -> hsl -> rgb rounding could return a hex a shade off
  // the one actually typed, and this field's whole point is accepting a brand's
  // OWN colour exactly.
  const submitHex = (text: string) => {
    setHexInput(text);
    const rgb = parseHex(text);
    if (rgb) onChange(toHex(rgb));
  };

  const ink = inkFor(value);
  const ratio = contrastRatio(ink, value);

  // The GROUND case (Market, above) always has something to report -- ink
  // flips, and the ratio beside it says how comfortably. The ACCENT case
  // doesn't: on Bold's dark ground the shop's own colour is used as TEXT
  // rather than the ground, and stepUntilContrast quietly nudges it when it
  // would otherwise vanish. The picker says nothing about that today, so an
  // owner never learns their exact pick isn't quite what prints. One quiet
  // line, only when stepping actually changed anything -- never a warning,
  // since the poster is correct either way.
  const accentOnDark = stepUntilContrast(value, DARK_TEMPLATE_GROUND, 4.5);
  const wasStepped = accentOnDark.toLowerCase() !== value.toLowerCase();

  return (
    <View style={styles.wrap}>
      <View style={styles.swatchRow}>
        {PRESETS.map((preset) => (
          <Pressable
            key={preset}
            onPress={() => onChange(preset)}
            accessibilityRole="button"
            accessibilityLabel={`Use ${preset}`}
            style={[styles.swatch, { backgroundColor: preset }, preset.toLowerCase() === value.toLowerCase() && styles.swatchOn]}
          />
        ))}
        {Platform.OS === 'web' ? (
          // @ts-ignore -- raw DOM element rendered via react-native-web, not a
          // React Native intrinsic; same pattern as date-input.tsx's
          // <input type="date"> web branch.
          <input type="color" value={value} onChange={(e: any) => onChange(e.target.value)} style={webInputStyle} />
        ) : null}
      </View>

      <View style={styles.topRow}>
        <View style={[styles.chip, { backgroundColor: value }]} />
        <TextInput
          value={hexInput}
          onChangeText={submitHex}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="#5B31B5"
          placeholderTextColor={theme.bentoMuted2}
          style={styles.hexInput}
        />
        {/* The ACTUAL ink colour the poster will use, not a "White"/"Black"
            label -- showing the real swatch is the consequence itself, and it
            needs no comparison against either of contrast.ts's two private
            ink constants to say so. */}
        <View style={styles.inkRow}>
          <View style={[styles.inkSwatch, { backgroundColor: ink }]} />
          <Text style={styles.inkRowText}>{ratio.toFixed(1)}:1</Text>
        </View>
      </View>

      {wasStepped && <Text style={styles.stepHint}>Lightened a touch on darker templates, so the text stays easy to read.</Text>}

      <Slider label="Hue" pct={hsl.h / 360} colors={hueTrack()} onDrag={(pct) => setFromHsl({ ...hsl, h: pct * 360 })} />
      <Slider label="Depth" pct={hsl.s / 100} colors={satTrack(hsl.h, hsl.l)} onDrag={(pct) => setFromHsl({ ...hsl, s: pct * 100 })} />
      <Slider label="Light" pct={hsl.l / 100} colors={lightTrack(hsl.h, hsl.s)} onDrag={(pct) => setFromHsl({ ...hsl, l: pct * 100 })} />
    </View>
  );
}

function Slider({ label, pct, colors, onDrag }: { label: string; pct: number; colors: string[]; onDrag: (pct: number) => void }) {
  // A ref, not state -- the track's own width only feeds a gesture
  // calculation, and turning it into state would re-render every slider on
  // every layout pass for no visible effect.
  const width = useRef(0);

  const update = (x: number) => {
    if (width.current <= 0) return;
    onDrag(clamp01(x / width.current));
  };

  // `useRef(PanResponder.create(...)).current` is the pattern React Native's
  // own PanResponder docs use -- constructed once, read directly, never
  // rebuilt on a re-render. There is nothing unsafe about it (the object
  // holds plain closures, no render-phase reads); the react-compiler eslint
  // rule flags it anyway, and does not honour an inline disable for this
  // particular diagnostic (verified: the comment below is reported as
  // "unused" by the same run that still reports the error) -- there is no
  // known PanResponder usage elsewhere in this codebase to match a precedent
  // against, so this is left as the documented, upstream-endorsed idiom
  // rather than reshaped around a rule that cannot currently be told about it.
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => update(e.nativeEvent.locationX),
      onPanResponderMove: (e) => update(e.nativeEvent.locationX),
    })
  ).current;

  return (
    <View style={styles.sliderRow}>
      <Text style={styles.sliderLabel}>{label}</Text>
      <View
        onLayout={(e) => {
          width.current = e.nativeEvent.layout.width;
        }}
        style={styles.track}
        {...responder.panHandlers}
      >
        <View style={styles.trackFill}>
          {colors.map((c, i) => (
            <View key={i} style={{ flex: 1, backgroundColor: c }} />
          ))}
        </View>
        <View pointerEvents="none" style={[styles.thumb, { left: `${clamp01(pct) * 100}%` }]} />
      </View>
    </View>
  );
}

const webInputStyle = {
  width: 34,
  height: 30,
  padding: 0,
  border: `1px solid ${theme.bentoLine}`,
  borderRadius: 10,
  background: theme.bentoSurface,
  cursor: 'pointer',
} as const;

const styles = StyleSheet.create({
  wrap: { backgroundColor: theme.bentoSoft, borderRadius: 16, padding: 13, gap: 10 },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  swatch: { width: 30, height: 30, borderRadius: 10, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: theme.bentoInk },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chip: { width: 34, height: 34, borderRadius: 11, borderWidth: 1, borderColor: theme.bentoLine },
  hexInput: {
    flex: 1,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 13,
    fontWeight: '700',
    color: theme.bentoInk,
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  inkRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inkSwatch: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: theme.bentoLine },
  inkRowText: { fontSize: 11, fontWeight: '800', color: theme.bentoMuted },
  stepHint: { fontSize: 11, color: theme.bentoMuted },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  sliderLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', color: theme.bentoMuted, width: 44 },
  track: { flex: 1, height: 22, justifyContent: 'center' },
  trackFill: { position: 'absolute', left: 0, right: 0, top: 4, height: 14, borderRadius: 7, flexDirection: 'row', overflow: 'hidden' },
  thumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    marginLeft: -10,
  },
});
