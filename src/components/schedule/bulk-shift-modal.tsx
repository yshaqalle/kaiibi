import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { MultiOptionPicker, OptionPicker } from '@/components/option-picker';
import { buildBulkShifts, type ShiftBlock, type ShiftDraft } from '@/lib/scheduling';
import { isValidTime } from '@/lib/store-hours';
import type { ShopLocation, StaffMember } from '@/types/models';

// Rostering several people across several days in one pass. Doing it through
// the single-shift editor is one modal per person per day -- thirty of them for
// five people over a week, which is why nobody did it.
//
// Like the shift editor, this is deliberately thin: buildBulkShifts decides
// what gets created and what is skipped, and it is unit-tested. There is no
// React Native testing library here, so logic left in this file is logic no
// test can reach.

function dayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

export function BulkShiftModal({
  visible,
  days,
  members,
  locations,
  seedLocationId,
  seedDate,
  existingShifts,
  onClose,
  onSave,
}: {
  visible: boolean;
  days: string[];
  members: StaffMember[];
  locations: ShopLocation[];
  seedLocationId?: string | null;
  seedDate?: string | null;
  // Everything already on the board, so the preview can say what won't land
  // before anything is written.
  existingShifts: { shopMemberId: string; date: string; start: string; end: string }[];
  onClose: () => void;
  onSave: (drafts: ShiftDraft[]) => Promise<void>;
}) {
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [dates, setDates] = useState<string[]>(seedDate ? [seedDate] : []);
  const [locationId, setLocationId] = useState(seedLocationId ?? locations[0]?.id ?? '');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('17:00');
  const [split, setSplit] = useState(false);
  const [secondStart, setSecondStart] = useState('17:00');
  const [secondEnd, setSecondEnd] = useState('21:00');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!visible) return null;

  const blocks: ShiftBlock[] = split ? [{ start, end }, { start: secondStart, end: secondEnd }] : [{ start, end }];
  const timesValid = blocks.every((block) => isValidTime(block.start) && isValidTime(block.end) && block.end > block.start);

  const { create, skipped } = timesValid
    ? buildBulkShifts({ memberIds, dates, blocks, locationId, note: note.trim() || null }, existingShifts)
    : { create: [] as ShiftDraft[], skipped: 0 };

  const blocked = !timesValid || !locationId || create.length === 0;

  const toggleDate = (date: string) =>
    setDates((current) => (current.includes(date) ? current.filter((d) => d !== date) : [...current, date]));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(create);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add these shifts.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Add shifts</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView>
            {locations.length > 1 && (
              <>
                <Text style={styles.label}>STORE</Text>
                <OptionPicker
                  value={locationId}
                  onChange={(id) => id && setLocationId(id)}
                  options={locations.map((location) => ({ id: location.id, label: location.name }))}
                  title="Which store are these shifts at?"
                />
              </>
            )}

            <Text style={styles.label}>STAFF</Text>
            {/* No "everyone" option: rostering the whole team by accident is a
                mistake worth one extra tap to avoid. */}
            <MultiOptionPicker
              values={memberIds}
              onChange={setMemberIds}
              options={members.map((member) => ({ id: member.id, label: member.fullName ?? 'Staff member' }))}
              title="Who is working these shifts?"
            />

            <Text style={styles.label}>DAYS</Text>
            <View style={styles.dayChips}>
              {days.map((date) => (
                <CategoryChip key={date} label={dayLabel(date)} active={dates.includes(date)} onPress={() => toggleDate(date)} />
              ))}
            </View>

            <View style={styles.timeRow}>
              <View style={styles.timeField}>
                <Text style={styles.label}>FROM</Text>
                <TextInput value={start} onChangeText={setStart} placeholder="09:00" placeholderTextColor="#999999" style={[styles.input, !isValidTime(start) && styles.inputInvalid]} />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.label}>TO</Text>
                <TextInput value={end} onChangeText={setEnd} placeholder="17:00" placeholderTextColor="#999999" style={[styles.input, !isValidTime(end) && styles.inputInvalid]} />
              </View>
            </View>

            <Pressable onPress={() => setSplit((on) => !on)} style={styles.splitToggle}>
              <Text style={styles.splitToggleText}>{split ? '− Remove the second block' : '+ Split into two blocks'}</Text>
            </Pressable>

            {split && (
              <View style={styles.timeRow}>
                <View style={styles.timeField}>
                  <Text style={styles.label}>THEN FROM</Text>
                  <TextInput value={secondStart} onChangeText={setSecondStart} placeholder="17:00" placeholderTextColor="#999999" style={[styles.input, !isValidTime(secondStart) && styles.inputInvalid]} />
                </View>
                <View style={styles.timeField}>
                  <Text style={styles.label}>TO</Text>
                  <TextInput value={secondEnd} onChangeText={setSecondEnd} placeholder="21:00" placeholderTextColor="#999999" style={[styles.input, !isValidTime(secondEnd) && styles.inputInvalid]} />
                </View>
              </View>
            )}

            <Text style={styles.label}>NOTE (OPTIONAL)</Text>
            <TextInput value={note} onChangeText={setNote} placeholder="e.g. stock take" placeholderTextColor="#999999" style={styles.input} />

            {!timesValid && <Text style={styles.blocking}>Use 24-hour times like 09:00, and end after you start.</Text>}

            {/* Says what will happen before it happens -- including what won't,
                because a batch that silently drops a clash is how someone ends
                up believing a shift exists. */}
            {timesValid && (
              <Text style={styles.preview}>
                {create.length === 0 && skipped === 0
                  ? 'Choose staff and days to see what will be created.'
                  : `Creates ${create.length} shift${create.length === 1 ? '' : 's'}${
                      skipped > 0 ? ` · skips ${skipped} that clash with a shift already there` : ''
                    }`}
              </Text>
            )}
            {error && <Text style={styles.blocking}>{error}</Text>}

            <View style={styles.actions}>
              <Pressable onPress={save} disabled={busy || blocked} style={[styles.primary, (busy || blocked) && styles.disabled]}>
                <Text style={styles.primaryText}>{busy ? 'Adding…' : 'Add shifts'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 460, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 15, fontWeight: '800', color: '#111111', flexShrink: 1 },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  dayChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  timeRow: { flexDirection: 'row', gap: 12 },
  timeField: { flex: 1 },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  inputInvalid: { borderWidth: 1, borderColor: '#C0392B', color: '#C0392B' },
  splitToggle: { alignSelf: 'flex-start', marginTop: 12 },
  splitToggleText: { color: '#111111', fontSize: 12, fontWeight: '700' },
  preview: { color: '#444444', fontSize: 12, fontWeight: '600', marginTop: 14 },
  blocking: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 20 },
  primary: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18 },
  primaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  disabled: { opacity: 0.5 },
});
