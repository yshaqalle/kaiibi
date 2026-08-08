import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Badge, Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { AppModal } from '@/components/ui/app-modal';
import { hasMultipleLocations } from '@/lib/location-selection';
import { formatCents, formatForeignCents, toCents } from '@/lib/currency';
import { BASE_CURRENCY, denominationsFor, withDenomination, withoutDenomination } from '@/lib/register-sessions';
import { createRegister, deleteRegister, updateRegister } from '@/lib/registers';
import { updateShop } from '@/lib/shops';
import type { Currency, Register, Shop, ShopLocation } from '@/types/models';

// The shop's registers. A register is a durable named place a sale is rung
// from — usually a counter with a drawer, sometimes a person's phone. It is not
// the same thing as a `Cashier`, which is only a label printed on a receipt:
// a cashier is WHO rang the sale up, a register is WHERE from, and only the
// register carries a drawer that gets counted.
//
// Mobile registers are created by the POS the first time someone opens a
// session with no counter free, so they are listed here but never added here.
//
// Follows LocationsPanel's shape: one modal handles both add and edit via an
// `editing: Register | 'new' | null` state var.

export function RegistersPanel({
  shop,
  registers,
  locations,
  sessionCounts,
  currencies,
  onChange,
  onShopSaved,
}: {
  shop: Shop;
  registers: Register[];
  locations: ShopLocation[];
  currencies: Currency[];
  // Per register. Drives both the "N sessions" line and whether Delete is
  // offered at all — see the onDelete note below.
  sessionCounts: Map<string, number>;
  onChange: () => Promise<void>;
  onShopSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Register | 'new' | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  const saveDenominations = async (next: Record<string, number[]>) => {
    setNoteError(null);
    try {
      await updateShop(shop.id, { cashDenominations: next });
      await onShopSaved();
    } catch (err) {
      setNoteError(extractErrorMessage(err, 'Could not save the note list.'));
    }
  };
  const multiStore = hasMultipleLocations(locations);

  return (
    <View>
      <PageHeader title="Registers" />

      {locations.map((location) => {
        const here = registers.filter((register) => register.locationId === location.id);
        return (
          <Section
            key={location.id}
            title={multiStore ? `${location.name} · ${here.length}` : `Registers · ${here.length}`}
          >
            {here.length === 0 && (
              <Text style={styles.hint}>
                No registers here yet. Until one exists, the POS says nothing about registers and sells exactly as it
                does today.
              </Text>
            )}
            {here.map((register) => (
              <Row
                key={register.id}
                label={register.name}
                desc={describeRegister(register, sessionCounts.get(register.id) ?? 0)}
                badge={!register.active ? <Badge>Inactive</Badge> : undefined}
              >
                <Btn onPress={() => setEditing(register)}>Edit</Btn>
              </Row>
            ))}
            <View style={styles.actionsRow}>
              <Btn onPress={() => setEditing({ ...blankRegister, locationId: location.id } as Register)}>
                New register
              </Btn>
            </View>

            {/* The switch itself lives with the store's other settings (Settings
                → Store locations), so there is one home for it and no chance of
                two screens disagreeing. The only thing worth saying HERE is the
                broken state: a store demanding a register it does not have
                cannot sell at all, and this is the screen where you fix it.
                Saying "this store requires one" when it HAS one would just
                describe a working setup back at the reader. */}
            {location.requireOpenRegister && here.length === 0 && (
              <Text style={styles.warn}>
                This store requires an open register but has none, so no sale can be rung up here. Add one below, or
                turn the rule off under Store locations.
              </Text>
            )}
          </Section>
        );
      })}

      <Section title="Notes in the drawer">
        <Text style={styles.hint}>
          What the note-by-note tally offers when someone counts a register. A starting point, not a limit — a cashier
          holding a note that is not here can add it mid-count, and keep it if they have settings access.
        </Text>
        {[BASE_CURRENCY, ...currencies.filter((c) => c.active).map((c) => c.code)]
          .filter((code, index, all) => all.indexOf(code) === index)
          .map((code) => (
            <NoteListEditor
              key={code}
              code={code}
              currency={currencies.find((c) => c.code === code) ?? null}
              notes={denominationsFor(shop.cashDenominations, code)}
              onAdd={(minor) => saveDenominations(withDenomination(shop.cashDenominations, code, minor))}
              onRemove={(minor) => saveDenominations(withoutDenomination(shop.cashDenominations, code, minor))}
            />
          ))}
        {noteError && <Text style={styles.error}>{noteError}</Text>}
      </Section>

      {editing !== null && (
        <RegisterEditorModal
          key={editing === 'new' ? 'new' : editing.id || 'new'}
          register={typeof editing === 'object' && editing.id ? editing : null}
          locationId={typeof editing === 'object' ? editing.locationId : locations[0]?.id}
          onClose={() => setEditing(null)}
          locations={locations}
          onSave={async (name, note, active, storeId) => {
            if (typeof editing === 'object' && editing.id) await updateRegister(editing.id, { name, note, active });
            else await createRegister(shop.id, storeId, name, note);
            await onChange();
            setEditing(null);
          }}
          // Offered only for a register nothing points at yet.
          // `register_sessions` references it `on delete restrict`, so a
          // register that has ever been opened refuses to delete — the point
          // being that deleting a counter must not erase its money history.
          // Once it has sessions, "retire this register" is what deactivating
          // is for, and the button is not offered rather than offered and
          // refused. (The catch inside the modal stays as a backstop: another
          // device can open a session between this list loading and the tap.)
          onDelete={
            typeof editing === 'object' && editing.id && (sessionCounts.get(editing.id) ?? 0) === 0
              ? async () => {
                  await deleteRegister(editing.id);
                  await onChange();
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </View>
  );
}

// The history is what decides whether this register can still be deleted, so it
// is worth saying on the row rather than only discovering it in the modal.
function describeRegister(register: Register, sessions: number): string {
  const what = register.kind === 'mobile' ? 'A phone, created by the POS' : 'A counter with a drawer';
  const history = sessions === 0 ? 'never opened' : sessions === 1 ? '1 session' : `${sessions} sessions`;
  // Note first: it is what tells someone scanning this list WHICH till this is,
  // which the name alone often cannot.
  return [register.note, what, history].filter(Boolean).join(' · ');
}

// One currency's note list. Tapping a note removes it; the field adds one.
// Deliberately plain: this is a list of numbers, and anything more elaborate
// would be a form for editing six integers.
function NoteListEditor({
  code,
  currency,
  notes,
  onAdd,
  onRemove,
}: {
  code: string;
  currency: Currency | null;
  notes: number[];
  onAdd: (minor: number) => void;
  onRemove: (minor: number) => void;
}) {
  const [draft, setDraft] = useState('');
  const format = (minor: number) =>
    currency ? formatForeignCents(minor, currency.symbol) : formatCents(minor);

  const add = () => {
    const minor = toCents(draft);
    setDraft('');
    if (minor > 0) onAdd(minor);
  };

  return (
    <View style={styles.noteBlock}>
      <Text style={styles.noteCode}>{currency ? `${currency.name} · ${code}` : 'US Dollars · USD'}</Text>
      <View style={styles.noteRow}>
        {notes.map((note) => (
          <Pressable key={note} onPress={() => onRemove(note)} style={styles.notePill}>
            <Text style={styles.notePillText}>{format(note)}</Text>
            <Text style={styles.notePillX}>×</Text>
          </Pressable>
        ))}
        {notes.length === 0 && <Text style={styles.hint}>No notes listed — the tally will offer only “Other”.</Text>}
      </View>
      <View style={styles.noteAddRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={currency ? 'e.g. 10000' : 'e.g. 200'}
          placeholderTextColor="#9CA3AF"
          keyboardType="decimal-pad"
          style={styles.noteInput}
          onSubmitEditing={add}
        />
        <Btn onPress={add}>Add note</Btn>
      </View>
    </View>
  );
}

const blankRegister = { id: '', name: '', kind: 'counter', active: true, locationId: '' };

function RegisterEditorModal({
  register,
  locationId,
  locations,
  onClose,
  onSave,
  onDelete,
}: {
  register: Register | null;
  locationId?: string;
  locations: ShopLocation[];
  onClose: () => void;
  onSave: (name: string, note: string, active: boolean, storeId: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(register?.name ?? '');
  const [note, setNote] = useState(register?.note ?? '');
  const [active, setActive] = useState(register?.active ?? true);
  // Pre-filled from whichever store's "New register" was tapped, but shown and
  // changeable all the same: inside the modal that context is gone, and a
  // register created at the wrong branch is not obvious until a cashier cannot
  // find it. Only offered for a business with more than one store.
  const [storeId, setStoreId] = useState(register?.locationId ?? locationId ?? locations[0]?.id ?? '');
  const store = locations.find((l) => l.id === storeId) ?? null;
  const multiStore = locations.length > 1;
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError('Give this register a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(name, note, active, storeId);
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this register.'));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch {
      // The restrict FK is the real gate, and its message is a Postgres
      // constraint name -- useless at a counter. Say what it actually means.
      setError('This register has sessions on it, so it cannot be deleted. Turn it off instead — its history stays.');
      setSaving(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>{register ? 'Edit register' : 'New register'}</Text>
            <View style={styles.cardActions}>
              <Btn onPress={onClose}>Close</Btn>
              <Btn onPress={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Btn>
            </View>
          </View>
          <ScrollView contentContainerStyle={styles.cardBody}>
            <Text style={styles.fieldLabel}>NAME</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Register 1 — front counter"
              placeholderTextColor="#9CA3AF"
              style={styles.input}
            />
            <Text style={styles.fieldHint}>
              What staff call this till. It appears on the register bar in the POS and on every session in the history,
              so name it the way people point at it.
            </Text>

            <Text style={styles.fieldLabel}>NOTE</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Near the pharmacy counter, by the back door"
              placeholderTextColor="#9CA3AF"
              multiline
              style={[styles.input, styles.noteInputTall]}
            />
            <Text style={styles.fieldHint}>
              Where this till stands, and anything a new cashier should know about it — a sticking drawer, no card
              reader, shared with another counter after six. Shown here and on the session detail, never in the POS
              bar. Keep which-one-is-it in the name above: a register called “Register 2” whose note says “actually
              the pharmacy one” leaves the name useless everywhere there is only room for a name.
            </Text>

            <Text style={styles.fieldLabel}>STORE</Text>
            {register ? (
              <>
                <Text style={styles.readOnly}>{store?.name ?? 'Unknown store'}</Text>
                <Text style={styles.fieldHint}>
                  A register belongs to the branch it stands in, and its past sessions are already recorded against
                  that branch. If a till genuinely moves, turn this one off and add one at the new store — that keeps
                  the old history where it happened.
                </Text>
              </>
            ) : multiStore ? (
              <>
                <View style={styles.storeRow}>
                  {locations.map((location) => (
                    <Pressable
                      key={location.id}
                      onPress={() => setStoreId(location.id)}
                      style={[styles.storeChip, location.id === storeId && styles.storeChipOn]}
                    >
                      <Text style={[styles.storeChipText, location.id === storeId && styles.storeChipTextOn]}>
                        {location.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.fieldHint}>
                  Which branch this till stands in. Sales rung on it, and the drawer counted at each end of a session,
                  all belong to this store.
                </Text>
              </>
            ) : (
              <Text style={styles.readOnly}>{store?.name ?? '—'}</Text>
            )}

            {register && (
              <>
                <View style={styles.switchRow}>
                  <Text style={styles.fieldLabel}>IN USE</Text>
                  <Switch value={active} onValueChange={setActive} />
                </View>
                <Text style={styles.fieldHint}>
                  Turn a register off when it stops being used. It disappears from the POS and keeps every session it
                  ever had.
                </Text>
              </>
            )}

                  {error && <Text style={styles.error}>{error}</Text>}

            {onDelete && (
              <View style={styles.deleteRow}>
                <Btn danger onPress={remove} disabled={saving}>
                  {confirmingDelete ? 'Really delete?' : 'Delete'}
                </Btn>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  hint: { fontSize: 12.5, color: '#6B7280', marginBottom: 10, lineHeight: 18 },
  warn: { fontSize: 12, color: '#B45309', marginTop: 8, lineHeight: 17 },
  error: { fontSize: 12.5, color: '#B91C1C', marginTop: 10 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '85%' },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  cardTitle: { fontSize: 16, fontWeight: '800', color: '#111' },
  cardActions: { flexDirection: 'row', gap: 8 },
  cardBody: { padding: 16 },
  fieldLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, color: '#9CA3AF', marginBottom: 6 },
  fieldHint: { fontSize: 11.5, color: '#6B7280', marginTop: 6, marginBottom: 14, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111',
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  deleteRow: { marginTop: 18, flexDirection: 'row' },
  readOnly: { fontSize: 14, fontWeight: '700', color: '#111', paddingVertical: 4 },
  storeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  storeChip: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  storeChipOn: { backgroundColor: '#111', borderColor: '#111' },
  storeChipText: { fontSize: 12.5, fontWeight: '700', color: '#111' },
  storeChipTextOn: { color: '#fff' },
  noteInputTall: { minHeight: 62, textAlignVertical: 'top' },
  noteBlock: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  noteCode: { fontSize: 12.5, fontWeight: '800', color: '#111', marginBottom: 8 },
  noteRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, alignItems: 'center' },
  notePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  notePillText: { fontSize: 12, fontWeight: '700', color: '#111' },
  notePillX: { fontSize: 12, color: '#9CA3AF' },
  noteAddRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 10 },
  noteInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13.5,
    color: '#111',
  },
});
