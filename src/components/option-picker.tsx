import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { Colors } from '@/constants/theme';
import { AppModal } from '@/components/ui/app-modal';

// Picking one of a list, presented as chips while the list is short and as a
// dropdown once it isn't.
//
// Chips read well at three or four options and are a single tap. They stop
// working as the list grows: they wrap into several rows, push everything below
// them down, and on a narrow screen a horizontal chip row hides the options
// that matter behind a scroll nobody notices. Every list this is used for —
// stores, staff, roles, cashiers — grows with the business, so the presentation
// has to change with it while the choice stays the same.
//
// The switch is on COUNT, not on which screen it is: the same picker with three
// stores and with nine should behave differently, and a component that decides
// per call site would drift.

export type PickerOption = { id: string; label: string; hint?: string };

// The chips use CategoryChip's `filter` variant, not its default. The default
// is sized for a tappable taxonomy tag (11px vertical padding); a filter chip
// sits in a control bar next to other filters, and at that size it towered
// over the date-range pills beside it.

// Above this many entries (the "all" entry included, since it takes a chip too)
// the control becomes a dropdown. Three is the point where a second row starts
// to be likely at typical widths.
const CHIP_LIMIT = 3;

export function OptionPicker({
  options,
  value,
  onChange,
  allOption,
  placeholder = 'Choose…',
  title,
  chipLimit = CHIP_LIMIT,
  variant = 'default',
}: {
  options: PickerOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  // When given, an extra entry meaning "no particular one" that selects `null`
  // — "All stores" on a filter, "Business-wide" on a cost. Omit where the
  // answer must be one of the options.
  allOption?: { label: string; hint?: string };
  placeholder?: string;
  title?: string;
  chipLimit?: number;
  /**
   * `bento` swaps the grey trigger for the white-on-hairline pill the bento
   * screens use. Same metrics, so the two can sit in one control bar without
   * one of them changing the bar's height.
   */
  variant?: 'default' | 'bento';
}) {
  const [open, setOpen] = useState(false);
  const total = options.length + (allOption ? 1 : 0);
  const selected = options.find((option) => option.id === value);
  const label = value === null ? (allOption?.label ?? placeholder) : (selected?.label ?? placeholder);

  if (total <= chipLimit) {
    return (
      <View style={styles.chipRow}>
        {allOption && <CategoryChip label={allOption.label} active={value === null} onPress={() => onChange(null)} variant="filter" />}
        {options.map((option) => (
          <CategoryChip key={option.id} label={option.label} active={value === option.id} onPress={() => onChange(option.id)} variant="filter" />
        ))}
      </View>
    );
  }

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={[styles.trigger, variant === 'bento' && styles.triggerBento]}>
        <Text style={[styles.triggerText, !selected && value !== null && styles.placeholder]} numberOfLines={1}>{label}</Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>
      <PickerSheet
        visible={open}
        title={title ?? placeholder}
        onClose={() => setOpen(false)}
        options={options}
        allOption={allOption}
        isSelected={(id) => id === value}
        isAllSelected={value === null}
        onPick={(id) => {
          onChange(id);
          setOpen(false);
        }}
      />
    </>
  );
}

// The set variant, for "which stores does this person work at". An EMPTY
// selection is meaningful here rather than absent — it is what "all of them"
// means — so `allOption` selects nothing rather than everything.
export function MultiOptionPicker({
  options,
  values,
  onChange,
  allOption,
  title,
  chipLimit = CHIP_LIMIT,
}: {
  options: PickerOption[];
  values: string[];
  onChange: (ids: string[]) => void;
  allOption?: { label: string; hint?: string };
  title?: string;
  chipLimit?: number;
}) {
  const [open, setOpen] = useState(false);
  const total = options.length + (allOption ? 1 : 0);

  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((existing) => existing !== id) : [...values, id]);

  const summary =
    values.length === 0
      ? (allOption?.label ?? 'None')
      : values.length === 1
        ? (options.find((option) => option.id === values[0])?.label ?? '1 selected')
        : `${values.length} selected`;

  if (total <= chipLimit) {
    return (
      <View style={styles.chipRow}>
        {allOption && <CategoryChip label={allOption.label} active={values.length === 0} onPress={() => onChange([])} variant="filter" />}
        {options.map((option) => (
          <CategoryChip key={option.id} label={option.label} active={values.includes(option.id)} onPress={() => toggle(option.id)} variant="filter" />
        ))}
      </View>
    );
  }

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.trigger}>
        <Text style={styles.triggerText} numberOfLines={1}>{summary}</Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>
      {/* Stays open on each tap, unlike the single-select sheet: choosing a set
          is several taps, and closing after the first would make picking three
          stores mean opening it three times. */}
      <PickerSheet
        visible={open}
        title={title ?? 'Choose'}
        onClose={() => setOpen(false)}
        options={options}
        allOption={allOption}
        isSelected={(id) => values.includes(id)}
        isAllSelected={values.length === 0}
        onPick={(id) => (id === null ? onChange([]) : toggle(id))}
        keepOpen
      />
    </>
  );
}

function PickerSheet({
  visible,
  title,
  onClose,
  options,
  allOption,
  isSelected,
  isAllSelected,
  onPick,
  keepOpen = false,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  options: PickerOption[];
  allOption?: { label: string; hint?: string };
  isSelected: (id: string) => boolean;
  isAllSelected: boolean;
  onPick: (id: string | null) => void;
  keepOpen?: boolean;
}) {
  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            {keepOpen && (
              <Pressable onPress={onClose} style={styles.done}>
                <Text style={styles.doneText}>Done</Text>
              </Pressable>
            )}
          </View>
          <ScrollView style={styles.list}>
            {allOption && (
              <Row label={allOption.label} hint={allOption.hint} selected={isAllSelected} onPress={() => onPick(null)} />
            )}
            {options.map((option) => (
              <Row
                key={option.id}
                label={option.label}
                hint={option.hint}
                selected={isSelected(option.id)}
                onPress={() => onPick(option.id)}
              />
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </AppModal>
  );
}

function Row({ label, hint, selected, onPress }: { label: string; hint?: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.option, selected && styles.optionSelected]}>
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{label}</Text>
        {/* Ternary, not `hint && …`: hint is a string, and an empty one would
            render as a bare text node inside a View — a hard error on RN Web. */}
        {hint ? <Text style={styles.optionHint}>{hint}</Text> : null}
      </View>
      {selected && <Text style={styles.check}>✓</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    backgroundColor: '#F2F2F2',
    borderRadius: 999,
    // Matched to CategoryChip's filter variant (8px padding, 13px text). This
    // control swaps between chips and this trigger purely on how many options
    // there are, so the two forms have to be the same height or adding a third
    // store visibly resizes the toolbar around it.
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  // Same padding and font as `trigger` above, so swapping variants never
  // changes the control bar's height.
  triggerBento: {
    backgroundColor: Colors.light.bentoSurface,
    borderWidth: 1,
    borderColor: Colors.light.bentoLine,
  },
  triggerText: { fontSize: 13, fontWeight: '600', color: '#111111', flexShrink: 1 },
  placeholder: { color: '#999999' },
  chevron: { fontSize: 10, color: '#111111' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420, maxHeight: '70%' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: '#111111', flex: 1 },
  done: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 9 },
  doneText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  list: { flexGrow: 0 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10 },
  optionSelected: { backgroundColor: '#F2F2F2' },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 14, fontWeight: '700', color: '#111111' },
  optionHint: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  check: { fontSize: 14, fontWeight: '800', color: '#111111' },
});
