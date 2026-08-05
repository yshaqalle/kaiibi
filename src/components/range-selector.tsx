import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { CategoryChip } from '@/components/category-chip';
import { DateInput, parseDateInput } from '@/components/date-input';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

export type RangePreset = { label: string; days: number };

// The dashboard's original three. Kept as the default so existing callers are
// unaffected; Accounting passes its own (Today/7/30, and 7/30/60 on the tabs
// whose windows run longer, like bills and budgets).
const DEFAULT_PRESETS: RangePreset[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export type DateRange = { since: Date; until?: Date };

// `days: 1` resolves to today alone -- the subtraction is (days - 1), so the
// window starts at this morning's midnight.
function presetRange(days: number): DateRange {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);
  return { since };
}

// Self-contained: owns its own preset/custom-range state and reports the
// resolved {since, until} whenever it changes, so screens embedding it don't
// have to duplicate the preset-vs-custom bookkeeping already used on Sales.
export function RangeSelector({
  onChange,
  presets = DEFAULT_PRESETS,
  initialDays,
}: {
  onChange: (range: DateRange) => void;
  presets?: RangePreset[];
  // Which preset to start on. Defaults to the first; Accounting's longer-window
  // tabs open on 30 days rather than the 7 at the head of their list.
  initialDays?: number;
}) {
  const startingDays = initialDays ?? presets[0].days;
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [days, setDays] = useState<number>(startingDays);
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onChange(presetRange(startingDays)); }, []);

  const customValid = useMemo(() => {
    const start = parseDateInput(startInput);
    const end = parseDateInput(endInput);
    return Boolean(start && end && start <= end);
  }, [startInput, endInput]);

  function selectPreset(next: number) {
    setMode('preset');
    setDays(next);
    onChange(presetRange(next));
  }

  function applyCustom() {
    if (!customValid) return;
    const since = parseDateInput(startInput)!;
    const until = parseDateInput(endInput)!;
    until.setHours(23, 59, 59, 999);
    setMode('custom');
    onChange({ since, until });
  }

  return (
    <View>
      {/* CategoryChip, not a local pill. These sit directly beside the store
          picker, which renders CategoryChips — and matching them by copying
          padding and font size is how the two drifted apart in the first
          place: same metrics, but a lighter border, a different grey and a
          lighter active weight. Sharing the component makes them identical by
          construction rather than by vigilance. */}
      <View style={styles.row}>
        {presets.map((preset) => (
          <CategoryChip
            key={preset.days}
            label={preset.label}
            active={mode === 'preset' && days === preset.days}
            onPress={() => selectPreset(preset.days)}
            variant="filter"
          />
        ))}
        <CategoryChip
          label="Custom"
          active={mode === 'custom'}
          onPress={() => setMode('custom')}
          variant="filter"
        />
      </View>
      {mode === 'custom' ? (
        <View style={styles.customRow}>
          <View style={styles.customField}>
            <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>FROM</Text>
            <DateInput value={startInput} onChangeText={setStartInput} />
          </View>
          <View style={styles.customField}>
            <Text style={[styles.fieldLabel, { color: theme.textSecondary }]}>TO</Text>
            <DateInput value={endInput} onChangeText={setEndInput} />
          </View>
          <Pressable
            onPress={applyCustom}
            disabled={!customValid}
            style={[styles.applyButton, { backgroundColor: customValid ? theme.text : theme.border }]}
          >
            <Text style={[styles.applyText, { color: theme.background }]}>Apply</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // No bottom margin: this now sits inline in Accounting's control bar, where
  // a trailing margin knocked it out of vertical centre. Callers that need
  // space below it own that space.
  row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  customRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 16 },
  customField: { flex: 1 },
  fieldLabel: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4, marginBottom: 4 },
  applyButton: { height: 42, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  applyText: { fontSize: 12, fontWeight: '700' },
});
