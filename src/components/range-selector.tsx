import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { DateInput, parseDateInput } from '@/components/date-input';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

const PRESETS = [7, 30, 90] as const;
type Preset = (typeof PRESETS)[number];

export type DateRange = { since: Date; until?: Date };

function presetRange(days: Preset): DateRange {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);
  return { since };
}

// Self-contained: owns its own preset/custom-range state and reports the
// resolved {since, until} whenever it changes, so screens embedding it don't
// have to duplicate the preset-vs-custom bookkeeping already used on Sales.
export function RangeSelector({ onChange }: { onChange: (range: DateRange) => void }) {
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [days, setDays] = useState<Preset>(7);
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onChange(presetRange(7)); }, []);

  const customValid = useMemo(() => {
    const start = parseDateInput(startInput);
    const end = parseDateInput(endInput);
    return Boolean(start && end && start <= end);
  }, [startInput, endInput]);

  function selectPreset(next: Preset) {
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
      <View style={styles.row}>
        {PRESETS.map((preset) => {
          const active = mode === 'preset' && days === preset;
          return (
            <Pressable
              key={preset}
              onPress={() => selectPreset(preset)}
              style={[styles.pill, { borderColor: theme.border }, active && { backgroundColor: theme.text, borderColor: theme.text }]}
            >
              <Text style={[styles.label, { color: active ? theme.background : theme.textSecondary }]}>{preset}d</Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => setMode('custom')}
          style={[styles.pill, { borderColor: theme.border }, mode === 'custom' && { backgroundColor: theme.text, borderColor: theme.text }]}
        >
          <Text style={[styles.label, { color: mode === 'custom' ? theme.background : theme.textSecondary }]}>Custom</Text>
        </Pressable>
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
  row: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  pill: { borderWidth: 1, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  label: { fontSize: 11, fontWeight: '700' },
  customRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 16 },
  customField: { flex: 1 },
  fieldLabel: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4, marginBottom: 4 },
  applyButton: { height: 42, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  applyText: { fontSize: 12, fontWeight: '700' },
});
