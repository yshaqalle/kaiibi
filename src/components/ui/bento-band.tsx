import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { BENTO_RADIUS, Colors } from '@/constants/theme';

const theme = Colors.light;

/**
 * A full-width card on `bentoInk` — the dark treatment, and the only one
 * besides the takings hero.
 *
 * The rule this encodes: dark is for the hero card and for FULL-WIDTH bands,
 * nothing else. A band runs the whole twelve columns, so it reads as a rule
 * between zones rather than as a tile competing with the hero. Three small
 * dark tiles beside a dark hero is where the screen loses its ground, which
 * is why the Top movers cards next to this one stayed white.
 *
 * White on this ground reads 19.7:1, so no new colour token is needed for the
 * text. Anything drawn as a CHART mark on it does need one: the light
 * profit/loss steps fall under the 3:1 mark floor here, and `Colors.dark`
 * carries mirrors chosen for exactly this case.
 */
export function BentoBand({
  title,
  /** One line under the title saying what decision the card is for. */
  blurb,
  /** Controls for the title row — a sort toggle, a granularity segment. */
  actions,
  children,
  style,
}: {
  title: string;
  blurb?: string;
  actions?: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.band, style]}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>{title}</Text>
          {blurb ? <Text style={styles.blurb}>{blurb}</Text> : null}
        </View>
        {actions ? <View style={styles.actions}>{actions}</View> : null}
      </View>
      {children}
    </View>
  );
}

/** A caption on a band. Exported so the cards inside one don't re-derive the grey. */
export function BandFoot({ children }: { children: ReactNode }) {
  return <Text style={styles.foot}>{children}</Text>;
}

/**
 * A pill on a band that DOES something when pressed.
 *
 * Carries a caret, unlike `BentoCard`'s scope pill, which is a label. The two
 * look near enough alike that without it a reader has to press one to find
 * out which kind it is — and a scope pill that ignores the press teaches them
 * the controls are broken.
 */
export function BandPill({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]} role="button">
      <Text style={styles.pillLabel}>{label}</Text>
      <Text style={styles.caret}>▾</Text>
    </Pressable>
  );
}

/** The Days/Weeks segment on a band. `SegmentedControl` is built for white. */
export function BandSegment<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  return (
    <View style={styles.segment} role="tablist">
      {options.map((option) => {
        const active = option.key === value;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={[styles.segButton, active && styles.segButtonOn]}
            role="tab"
            aria-selected={active}
          >
            <Text style={[styles.segLabel, active && styles.segLabelOn]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The muted step for text on ink. 7.4:1 on `bentoInk`. */
export const ON_INK_MUTED = '#a6a6ae';

const styles = StyleSheet.create({
  band: { borderRadius: BENTO_RADIUS, backgroundColor: theme.bentoInk, padding: 18 },
  // Wraps rather than shrinking the title: at 6 columns the segment control
  // beside it would squeeze "Best sellers" to two characters and an ellipsis.
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  headText: { flexGrow: 1, flexShrink: 1, flexBasis: 200 },
  actions: { flexShrink: 0 },
  title: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4, color: '#ffffff' },
  blurb: { fontSize: 12, color: ON_INK_MUTED, marginTop: 3, lineHeight: 17 },
  foot: { fontSize: 11.5, color: ON_INK_MUTED, marginTop: 12, lineHeight: 17 },

  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 6,
    overflow: 'hidden',
  },
  pillPressed: { backgroundColor: 'rgba(255,255,255,0.2)' },
  pillLabel: { fontSize: 12, fontWeight: '700', color: '#ffffff' },
  caret: { fontSize: 9, color: ON_INK_MUTED },

  segment: { flexDirection: 'row', gap: 8 },
  segButton: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  segButtonOn: { backgroundColor: '#ffffff', borderColor: '#ffffff' },
  segLabel: { fontSize: 12.5, fontWeight: '700', color: '#ffffff' },
  segLabelOn: { color: theme.bentoInk },
});
