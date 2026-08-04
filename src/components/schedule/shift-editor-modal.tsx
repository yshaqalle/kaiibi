import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { OptionPicker } from '@/components/option-picker';
import { hasBlockingProblem, validateShift, type Shift, type ShiftDraft, type ShiftProblem, type ValidationContext } from '@/lib/scheduling';
import { isValidTime } from '@/lib/store-hours';
import type { ShopLocation, StaffMember } from '@/types/models';

// The editor is deliberately thin: every rule it enforces comes from
// validateShift in scheduling.ts, which is unit-tested. There is no React
// Native testing library here, so logic placed in this file would be logic no
// test can reach.

export function ShiftEditorModal({
  visible,
  date,
  members,
  existing,
  seedMemberId,
  context,
  locations,
  onClose,
  onSave,
  onDelete,
}: {
  visible: boolean;
  date: string;
  members: StaffMember[];
  existing: Shift | null;
  // Which row/cell was tapped to open the editor -- honoured for a NEW shift
  // only. An existing shift's own shopMemberId always wins, so editing a
  // shift never reassigns it just because the modal remembers where it was
  // opened from.
  seedMemberId?: string | null;
  context: ValidationContext;
  // Stores this shift may be scheduled at. A shift is always AT one — there is
  // no business-wide shift — so unlike the accounting editors this picker has
  // no null option.
  locations: ShopLocation[];
  onClose: () => void;
  onSave: (draft: ShiftDraft, note: string | null) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [memberId, setMemberId] = useState(existing?.shopMemberId ?? seedMemberId ?? members[0]?.id ?? '');
  const [start, setStart] = useState(existing?.start ?? '09:00');
  const [end, setEnd] = useState(existing?.end ?? '17:00');
  const [note, setNote] = useState(existing?.note ?? '');
  const [locationId, setLocationId] = useState(existing?.locationId ?? locations[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!visible) return null;

  const timesValid = isValidTime(start) && isValidTime(end) && end > start;
  const draft = { shopMemberId: memberId, locationId, date, start, end };
  // Hours come from the shift's OWN store, not the device's: once two stores
  // keep different hours, "outside opening hours" only means anything if it is
  // asked of the store the shift is actually worked at. This replaces the
  // interim that read the active store (migration 20260815000000).
  const hours = locations.find((location) => location.id === locationId)?.openingHours ?? {};
  // Exclude the shift being edited, or it would always clash with itself.
  const problems: ShiftProblem[] = timesValid
    ? validateShift(draft, { ...context, hours, sameDayShifts: context.sameDayShifts.filter((s) => s.id !== existing?.id) })
    : [];
  const blocked = !timesValid || !memberId || hasBlockingProblem(problems);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(draft, note.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this shift.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this shift.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{existing ? 'Edit shift' : 'New shift'} · {date}</Text>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          {/* Only when there's a choice — a single-store business has one
              answer and the row would be noise. */}
          {locations.length > 1 && (
            <>
              <Text style={styles.label}>STORE</Text>
              <OptionPicker
                value={locationId}
                onChange={(id) => id && setLocationId(id)}
                options={locations.map((location) => ({ id: location.id, label: location.name }))}
                title="Which store is this shift at?"
              />
            </>
          )}

          <Text style={styles.label}>STAFF</Text>
          {/* The list this most needed a dropdown for: a shop with a dozen
              staff turned this into four wrapped rows of chips. */}
          <OptionPicker
            value={memberId}
            onChange={(id) => id && setMemberId(id)}
            options={members.map((member) => ({ id: member.id, label: member.fullName ?? 'Staff member' }))}
            title="Who is working this shift?"
            placeholder="Choose someone"
          />

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

          <Text style={styles.label}>NOTE (OPTIONAL)</Text>
          <TextInput value={note} onChangeText={setNote} placeholder="e.g. covering the delivery" placeholderTextColor="#999999" style={styles.input} />

          {!timesValid && <Text style={styles.blocking}>Use 24-hour times like 09:00, and end after you start.</Text>}
          {problems.map((problem) => (
            <Text key={problem.kind} style={problem.blocking ? styles.blocking : styles.advisory}>
              {problem.message}
            </Text>
          ))}
          {error && <Text style={styles.blocking}>{error}</Text>}

          <View style={styles.actions}>
            <Pressable onPress={save} disabled={busy || blocked} style={[styles.primary, (busy || blocked) && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save shift'}</Text>
            </Pressable>
            {existing && (
              <Pressable onPress={remove} disabled={busy}>
                <Text style={styles.danger}>Delete</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 460 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 15, fontWeight: '800', color: '#111111', flexShrink: 1 },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginTop: 12, marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  timeRow: { flexDirection: 'row', gap: 12 },
  timeField: { flex: 1 },
  input: { backgroundColor: '#F2F2F2', height: 42, borderRadius: 10, paddingHorizontal: 12, color: '#111111' },
  inputInvalid: { borderWidth: 1, borderColor: '#C0392B', color: '#C0392B' },
  blocking: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 10 },
  advisory: { color: '#B7791F', fontSize: 12, fontWeight: '600', marginTop: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 20 },
  primary: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 18 },
  primaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  danger: { color: '#C0392B', fontWeight: '700', fontSize: 13 },
  disabled: { opacity: 0.5 },
});
