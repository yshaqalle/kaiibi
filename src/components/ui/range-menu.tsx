import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { OptionPicker } from '@/components/option-picker';
import type { DateRange, RangePreset } from '@/components/range-selector';
import { Colors } from '@/constants/theme';

const theme = Colors.light;

// The date range as a single pill — "7 days ▾" — rather than RangeSelector's
// inline row of chips.
//
// Same choice, less width. The bento screens put the range in a header row
// that already carries a store picker and an export button, and four chips
// plus "Custom" wrapped to a second line there on anything narrower than a
// tablet. The cost is one extra tap to change range, which is the right trade
// for a control that is set once and then left alone.
//
// The dropdown itself is OptionPicker, not a new one: a preset IS an option,
// so the sheet, the trigger, the selected state and the styling all come for
// free and cannot drift from the store picker beside it.

/** Presets are addressed by day count, which is already their identity. */
const CUSTOM_ID = 'custom';

// Mirrors RangeSelector.presetRange -- `days: 1` is today alone, so the
// subtraction is (days - 1) and the window opens at this morning's midnight.
function presetRange(days: number): DateRange {
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);
  return { since };
}

function formatShort(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function RangeMenu({
  presets,
  initialDays,
  onChange,
  variant = 'bento',
}: {
  presets: RangePreset[];
  initialDays?: number;
  onChange: (range: DateRange) => void;
  variant?: 'default' | 'bento';
}) {
  const startingDays = initialDays ?? presets[0].days;
  const [selected, setSelected] = useState<string>(String(startingDays));
  const [customOpen, setCustomOpen] = useState(false);
  const [customLabel, setCustomLabel] = useState<string | null>(null);
  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');

  // Reports the opening range once, matching RangeSelector's own behaviour --
  // the screens embedding this hold `dateRange` as null until it arrives and
  // skip their fetch until then.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onChange(presetRange(startingDays)); }, []);

  const customValid = useMemo(() => {
    const start = parseDateInput(startInput);
    const end = parseDateInput(endInput);
    return Boolean(start && end && start <= end);
  }, [startInput, endInput]);

  const options = useMemo(
    () => [
      ...presets.map((preset) => ({ id: String(preset.days), label: preset.label })),
      { id: CUSTOM_ID, label: customLabel ?? 'Custom…', hint: 'Pick your own dates' },
    ],
    [presets, customLabel]
  );

  const pick = (id: string | null) => {
    if (id === null) return;
    if (id === CUSTOM_ID) {
      setCustomOpen(true);
      return;
    }
    setSelected(id);
    setCustomLabel(null);
    onChange(presetRange(Number(id)));
  };

  const applyCustom = () => {
    if (!customValid) return;
    const since = parseDateInput(startInput)!;
    const until = parseDateInput(endInput)!;
    // Inclusive of the end day, same as RangeSelector -- a range ending today
    // must contain a sale rung up this afternoon.
    until.setHours(23, 59, 59, 999);
    setSelected(CUSTOM_ID);
    setCustomLabel(`${formatShort(since)} – ${formatShort(until)}`);
    setCustomOpen(false);
    onChange({ since, until });
  };

  return (
    <>
      <OptionPicker
        options={options}
        value={selected}
        onChange={pick}
        // Always the dropdown, never chips: this sits beside the store picker
        // and an export button, and the two controls have to read as a pair.
        chipLimit={0}
        title="Show figures for"
        variant={variant}
      />

      <Modal visible={customOpen} transparent animationType="fade" onRequestClose={() => setCustomOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setCustomOpen(false)}>
          {/* Swallows taps inside the card so choosing a date doesn't dismiss
              the sheet the way tapping the backdrop does. */}
          <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.sheetTitle}>Custom range</Text>
            <View style={styles.fields}>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>FROM</Text>
                <DateInput value={startInput} onChangeText={setStartInput} />
              </View>
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>TO</Text>
                <DateInput value={endInput} onChangeText={setEndInput} />
              </View>
            </View>
            <View style={styles.actions}>
              <Pressable onPress={() => setCustomOpen(false)} style={styles.cancel}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={applyCustom}
                disabled={!customValid}
                style={[styles.apply, { backgroundColor: customValid ? theme.bentoInk : theme.bentoLine }]}
              >
                <Text style={styles.applyText}>Apply</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: theme.bentoSurface, borderRadius: 18, padding: 20, width: '100%', maxWidth: 420 },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: theme.bentoInk, marginBottom: 14 },
  fields: { flexDirection: 'row', gap: 10 },
  field: { flex: 1 },
  fieldLabel: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4, color: theme.bentoMuted, marginBottom: 4 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
  cancel: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10 },
  cancelText: { fontSize: 13, fontWeight: '700', color: theme.bentoMuted },
  apply: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 10 },
  applyText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
});
