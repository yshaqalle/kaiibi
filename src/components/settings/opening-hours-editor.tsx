import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  DAY_LABELS,
  DEFAULT_RANGE,
  WEEK_ORDER,
  findDayProblem,
  formatDayHours,
  gapsBetween,
  isValidTime,
  normalizeDay,
  suggestNextRange,
  type OpeningHours,
  type TimeRange,
  type WeekdayKey,
} from '@/lib/store-hours';

// Seven rows, one per weekday, each reading as the sentence it will print on a
// receipt. Tapping a row opens that day's blocks underneath it.
//
// A day is a LIST of blocks -- a shop that shuts for lunch or prayer and
// reopens is two, and there is no cap. The summary row is what keeps that
// affordable: however many blocks a Saturday carries, the week is still seven
// rows plus the one day being worked on.
//
// ONE day is open at a time. Opening another collapses the first, which keeps
// the list short and keeps "Copy to every day" unambiguous about which day it
// means.
//
// Every rule about the blocks themselves -- overlap, ordering, merging blocks
// that touch -- lives in store-hours.ts, where Jest can reach it. There is no
// React Native testing library in this repo, so logic in here is logic no test
// can reach. This file decides only what is on screen.
//
// Times are plain text inputs validated against 'HH:MM', matching how DateInput
// handles dates in this codebase rather than introducing a picker.

function setDay(hours: OpeningHours, day: WeekdayKey, ranges: TimeRange[]): OpeningHours {
  return { ...hours, [day]: ranges };
}

// What the collapsed row says. "Not set" and "Closed" are different answers:
// absent means the owner has never touched this day, [] means they have said
// the shop is shut. isConfigured and the shift scheduler both depend on the
// difference, so the row shows it rather than flattening it.
function summarize(ranges: TimeRange[] | undefined): { text: string; muted: boolean } {
  if (ranges === undefined) return { text: 'Not set', muted: true };
  const text = formatDayHours(ranges);
  return { text, muted: text === 'Closed' };
}

function BlockRow({
  range,
  problem,
  onChange,
  onRemove,
}: {
  range: TimeRange;
  problem: string | null;
  onChange: (next: TimeRange) => void;
  onRemove: () => void;
}) {
  return (
    <View>
      <View style={styles.blockRow}>
        <TextInput
          value={range.open}
          onChangeText={(open) => onChange({ ...range, open })}
          placeholder="09:00"
          placeholderTextColor="#999999"
          style={[styles.time, !isValidTime(range.open) && styles.timeInvalid]}
        />
        <Text style={styles.dash}>–</Text>
        <TextInput
          value={range.close}
          onChangeText={(close) => onChange({ ...range, close })}
          placeholder="18:00"
          placeholderTextColor="#999999"
          style={[styles.time, !isValidTime(range.close) && styles.timeInvalid]}
        />
        <Pressable onPress={onRemove} hitSlop={8} style={styles.remove} accessibilityLabel="Remove these hours">
          <Text style={styles.removeText}>×</Text>
        </Pressable>
      </View>
      {problem ? <Text style={styles.problem}>{problem}</Text> : null}
    </View>
  );
}

function DaySheet({
  day,
  hours,
  onChange,
}: {
  day: WeekdayKey;
  hours: OpeningHours;
  onChange: (next: OpeningHours) => void;
}) {
  const ranges = hours[day] ?? [];
  const problem = findDayProblem(ranges);
  // Blocks are shown in the order they were typed, so the message must be
  // anchored to that same index -- with three or four blocks, an unanchored
  // "these overlap" means counting rows to find which.
  const gaps = gapsBetween(ranges);

  const replace = (index: number, next: TimeRange) =>
    onChange(setDay(hours, day, ranges.map((range, i) => (i === index ? next : range))));

  // Removing the last block leaves [], which is "Closed" -- not absent. The
  // owner has now said something about this day.
  const remove = (index: number) => onChange(setDay(hours, day, ranges.filter((_, i) => i !== index)));

  // Copies over every day including ones never configured. Most shops keep one
  // pattern all week, so this is the difference between setting hours once and
  // setting them seven times.
  const copyToEveryDay = () => {
    const next: OpeningHours = { ...hours };
    for (const other of WEEK_ORDER) next[other] = ranges.map((range) => ({ ...range }));
    onChange(next);
  };

  return (
    <View style={styles.sheet}>
      {ranges.map((range, index) => (
        <BlockRow
          key={index}
          range={range}
          problem={problem?.index === index ? problem.message : null}
          onChange={(next) => replace(index, next)}
          onRemove={() => remove(index)}
        />
      ))}

      {/* The closure is the reason for splitting the day, so it is stated
          rather than left to be inferred from two rows of numbers. */}
      {gaps.map((gap) => (
        <Text key={gap.open} style={styles.gap}>
          Closed {gap.open} – {gap.close}
        </Text>
      ))}

      {ranges.length === 0 ? <Text style={styles.gap}>Closed all day.</Text> : null}

      <View style={styles.sheetActions}>
        <Pressable onPress={() => onChange(setDay(hours, day, [...ranges, suggestNextRange(ranges)]))}>
          <Text style={styles.addBlock}>+ Add hours</Text>
        </Pressable>
        {ranges.length > 0 ? (
          <Pressable onPress={() => onChange(setDay(hours, day, []))}>
            <Text style={styles.sheetAction}>Mark closed</Text>
          </Pressable>
        ) : null}
        {ranges.length > 0 ? (
          <Pressable onPress={copyToEveryDay}>
            <Text style={styles.sheetAction}>Copy to every day</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function OpeningHoursEditor({ value, onChange }: { value: OpeningHours; onChange: (next: OpeningHours) => void }) {
  const [openDay, setOpenDay] = useState<WeekdayKey | null>(null);

  // Both state changes a tap can cause, resolved into ONE onChange: collapsing
  // the day being left, and seeding the day being opened. Two calls would have
  // the second built from a `value` prop the first has not re-rendered yet, and
  // the seed would silently win over the normalisation.
  const open = (day: WeekdayKey | null) => {
    let next = value;

    // Sorting and merging happen as a day closes, not per keystroke: reordering
    // a block under the cursor while someone is still typing it would be
    // hostile. Doing it here also means the merge is VISIBLE -- the summary row
    // updates as the day collapses -- rather than happening silently at Save.
    if (openDay && openDay !== day && next[openDay]) {
      next = setDay(next, openDay, normalizeDay(next[openDay]));
    }

    // A day that has never been configured opens showing a default block rather
    // than an empty sheet. It is on screen and editable before it counts for
    // anything -- nothing reaches the database until the modal is saved, and
    // "Mark closed" is right there for a day that should stay shut.
    if (day && next[day] === undefined) next = setDay(next, day, [{ ...DEFAULT_RANGE }]);

    if (next !== value) onChange(next);
    setOpenDay(day);
  };

  return (
    <View>
      {WEEK_ORDER.map((day) => {
        const isOpen = openDay === day;
        const summary = summarize(value[day]);
        return (
          <View key={day} style={[styles.day, isOpen && styles.dayOpen]}>
            {/* The whole row is the target, not a small "Edit" link: one tap to
                open, edit in place, tap the next day. */}
            <Pressable style={styles.dayLine} onPress={() => open(isOpen ? null : day)}>
              <Text style={styles.dayName}>{DAY_LABELS[day]}</Text>
              {/* Deliberately unbounded: a three-block Saturday wraps to a
                  taller row rather than being truncated. Hours hidden behind an
                  ellipsis are hours the owner cannot check against the door. */}
              <Text style={[styles.summary, summary.muted && styles.summaryMuted]}>{summary.text}</Text>
              <Text style={isOpen ? styles.done : styles.caret}>{isOpen ? 'Done' : '›'}</Text>
            </Pressable>
            {isOpen ? <DaySheet day={day} hours={value} onChange={onChange} /> : null}
          </View>
        );
      })}
      <Text style={styles.footnote}>This is what prints on the receipt. Tap a day to change it.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  day: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  dayOpen: { backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 10, marginHorizontal: -10, borderBottomColor: 'transparent' },
  dayLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dayName: { fontSize: 13, fontWeight: '700', color: '#111111', width: 92 },
  summary: { fontSize: 13, color: '#111111', flex: 1 },
  summaryMuted: { color: '#999999' },
  caret: { fontSize: 15, color: '#999999', fontWeight: '700' },
  done: { fontSize: 12, fontWeight: '700', color: '#999999' },

  sheet: { backgroundColor: '#F2F2F2', borderRadius: 12, padding: 12, marginTop: 9, gap: 8 },
  blockRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  time: { backgroundColor: '#FFFFFF', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: '#111111', width: 78, textAlign: 'center' },
  timeInvalid: { borderWidth: 1, borderColor: '#C0392B', color: '#C0392B' },
  dash: { fontSize: 13, color: '#999999' },
  remove: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  removeText: { fontSize: 15, color: '#999999', lineHeight: 18 },
  problem: { fontSize: 11.5, fontWeight: '600', color: '#C0392B', marginTop: 5 },
  gap: { fontSize: 11.5, color: '#9CA3AF' },
  sheetActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 14, marginTop: 2 },
  addBlock: { fontSize: 12, fontWeight: '700', color: '#111111' },
  sheetAction: { fontSize: 12, fontWeight: '700', color: '#999999' },
  footnote: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 10 },
});
