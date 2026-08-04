import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { OpeningHoursEditor } from '@/components/settings/opening-hours-editor';
import { Badge, Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { toCents } from '@/lib/currency';
import { createLocation, deleteLocation, setPrimaryLocation, updateLocation } from '@/lib/locations';
import { DAY_LABELS, WEEK_ORDER, isValidRange, rangesFor, type OpeningHours } from '@/lib/store-hours';
import type { NewShopLocationInput, ShopLocation } from '@/types/models';

// The shop's stores. `Shop` is the business — one name, one logo, one set of
// books; each row here is a store it trades from, carrying its OWN name,
// address, phone, hours and code. Two stores under one business can be named
// differently ("Ka Iibi Hargeisa", "Ka Iibi Berbera"), which is why the name
// lives here rather than being inherited from the shop.
//
// The store selected in the header is where a sale gets recorded, which stock
// the POS decrements, and whose address a receipt prints.
//
// Follows VendorsPanel's shape: one modal handles both add and edit via an
// `editing: ShopLocation | 'new' | null` state var.

export function LocationsPanel({
  shopId,
  locations,
  onChange,
}: {
  shopId: string;
  locations: ShopLocation[];
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<ShopLocation | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => setEditing(null);

  const makePrimary = async (location: ShopLocation) => {
    setError(null);
    try {
      await setPrimaryLocation(shopId, location.id);
      await onChange();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not change the main store.'));
    }
  };

  return (
    <View>
      <PageHeader title="Store locations" />
      <Section title={`Stores · ${locations.length}`}>
        <Text style={styles.hint}>
          Each store your business trades from, with its own name, address and opening hours. The store picked in the
          header is where sales are recorded, which stock is counted, and whose address prints on the receipt.
        </Text>
        {locations.map((location) => (
          <Row
            key={location.id}
            label={location.name}
            desc={describeLocation(location)}
            badge={location.isPrimary ? <Badge>Main</Badge> : undefined}
          >
            {!location.isPrimary && location.active && <Btn onPress={() => makePrimary(location)}>Make main</Btn>}
            <Btn onPress={() => setEditing(location)}>Edit</Btn>
          </Row>
        ))}
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.actionsRow}>
          <Btn onPress={() => setEditing('new')}>New store</Btn>
        </View>
      </Section>

      {/* Mounted only while editing, and keyed by which location — so the form
          fields initialise straight from props on open instead of needing an
          effect to sync them back on every change of `editing`. */}
      {editing !== null && (
        <LocationEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          location={editing === 'new' ? null : editing}
          onClose={close}
          onSave={async (input) => {
            if (editing !== 'new') await updateLocation(editing.id, input);
            else await createLocation(shopId, input);
            await onChange();
            close();
          }}
          // Deleting is offered only for a location nothing can point at yet.
          // The main location is never deletable: a shop with none can't take a
          // sale, and "close this branch" is what deactivating is for.
          onDelete={
            editing !== 'new' && !editing.isPrimary
              ? async () => {
                  await deleteLocation(editing.id);
                  await onChange();
                  close();
                }
              : undefined
          }
        />
      )}
    </View>
  );
}

function describeLocation(location: ShopLocation): string | undefined {
  const place = [location.address, location.neighborhood, location.city].filter(Boolean).join(' · ');
  const parts = [
    location.code ? `#${location.code}` : undefined,
    place || undefined,
    location.contactPhone || undefined,
    location.active ? undefined : 'Closed',
  ];
  return parts.filter(Boolean).join(' — ') || undefined;
}

function LocationEditorModal({
  location,
  onClose,
  onSave,
  onDelete,
}: {
  location: ShopLocation | null;
  onClose: () => void;
  onSave: (input: NewShopLocationInput) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(location?.name ?? '');
  const [code, setCode] = useState(location?.code ?? '');
  const [address, setAddress] = useState(location?.address ?? '');
  const [neighborhood, setNeighborhood] = useState(location?.neighborhood ?? '');
  const [city, setCity] = useState(location?.city ?? '');
  const [contactPhone, setContactPhone] = useState(location?.contactPhone ?? '');
  const [openingHours, setOpeningHours] = useState<OpeningHours>(location?.openingHours ?? {});
  const [goalInput, setGoalInput] = useState(
    location?.monthlyRevenueGoalCents != null ? String(location.monthlyRevenueGoalCents / 100) : ''
  );
  const [active, setActive] = useState(location?.active ?? true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The main location can't be closed — it's the fallback every session falls
  // back to, so deactivating it would leave a shop with nothing to sell from.
  const canDeactivate = !location?.isPrimary;
  const canSave = Boolean(name.trim()) && !saving;

  const save = async () => {
    if (!canSave) return;
    // A range the rest of the app can't interpret must not reach the database.
    // Naming the day matters: seven rows of time inputs make "invalid time"
    // alone useless. Carried over from StorePanel, which owned hours before
    // migration 20260809000000 moved them onto the location.
    const badDay = WEEK_ORDER.find((day) => rangesFor(openingHours, day).some((range) => !isValidRange(range)));
    if (badDay) {
      setError(`${DAY_LABELS[badDay]}'s hours aren't valid — use 24-hour times like 09:00, and close after you open.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        code: code.trim() || null,
        address: address.trim() || null,
        neighborhood: neighborhood.trim() || null,
        city: city.trim() || null,
        contactPhone: contactPhone.trim() || null,
        openingHours,
        monthlyRevenueGoalCents: goalInput.trim() ? toCents(goalInput) : null,
        active,
      });
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this store.'));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not delete this store.'));
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>{location ? 'Edit store' : 'New store'}</Text>
            <View style={modalStyles.headerActions}>
              <Pressable onPress={save} disabled={!canSave} style={[modalStyles.addButton, !canSave && modalStyles.buttonDisabled]}>
                <Text style={modalStyles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={modalStyles.close}>
                <Text style={modalStyles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView style={modalStyles.list}>
            <Text style={modalStyles.fieldLabel}>STORE NAME</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Ka Iibi Airport Road"
              placeholderTextColor="#999999"
              style={modalStyles.input}
            />
            <Text style={modalStyles.fieldHint}>
              What this store is called. It can differ from your business name.
            </Text>

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>BRANCH CODE (OPTIONAL)</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="e.g. 002 or AR"
              placeholderTextColor="#999999"
              autoCapitalize="characters"
              style={modalStyles.input}
            />
            <Text style={modalStyles.fieldHint}>
              A short name for this store in reports and imports. It stays the same if you rename the store. Leave it
              blank if you don&apos;t use one.
            </Text>

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>STREET ADDRESS</Text>
            <TextInput value={address} onChangeText={setAddress} placeholder="Unit or building, street" placeholderTextColor="#999999" style={modalStyles.input} />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>NEIGHBORHOOD OR LANDMARK</Text>
            <TextInput
              value={neighborhood}
              onChangeText={setNeighborhood}
              placeholder="e.g. Jigjiga Yar, near the main market"
              placeholderTextColor="#999999"
              style={modalStyles.input}
            />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>CITY</Text>
            <TextInput value={city} onChangeText={setCity} placeholder="Hargeisa" placeholderTextColor="#999999" style={modalStyles.input} />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>PHONE</Text>
            <TextInput
              value={contactPhone}
              onChangeText={setContactPhone}
              placeholder="Phone number for this store"
              placeholderTextColor="#999999"
              keyboardType="phone-pad"
              style={modalStyles.input}
            />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>MONTHLY REVENUE GOAL</Text>
            <TextInput
              value={goalInput}
              onChangeText={setGoalInput}
              placeholder="e.g. 5000"
              placeholderTextColor="#999999"
              keyboardType="decimal-pad"
              style={modalStyles.input}
            />
            <Text style={modalStyles.fieldHint}>
              This store&apos;s target for the month. Each store can set its own. Leave blank to hide the goal meter.
            </Text>

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>OPENING HOURS</Text>
            <OpeningHoursEditor value={openingHours} onChange={setOpeningHours} />

            {canDeactivate && (
              <Pressable onPress={() => setActive((current) => !current)} style={modalStyles.statusRow}>
                <Text style={modalStyles.statusLabel}>{active ? 'Open' : 'Closed'}</Text>
                <Text style={modalStyles.statusAction}>{active ? 'Mark as closed' : 'Reopen'}</Text>
              </Pressable>
            )}
            {canDeactivate && !active && (
              <Text style={modalStyles.statusHint}>
                A closed store keeps its past sales and shifts, but stops appearing in the store picker.
              </Text>
            )}

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={modalStyles.formActions}>
              {onDelete ? (
                confirmingDelete ? (
                  <View style={modalStyles.confirmRow}>
                    <Text style={modalStyles.confirmText}>Delete this store?</Text>
                    <Pressable onPress={remove} disabled={saving} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextDanger}>Confirm</Text>
                    </Pressable>
                    <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextMuted}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving} style={modalStyles.rowAction}>
                    <Text style={modalStyles.rowActionTextDanger}>Delete store</Text>
                  </Pressable>
                )
              ) : (
                <View />
              )}
              <Pressable onPress={save} disabled={!canSave} style={[modalStyles.addButton, !canSave && modalStyles.buttonDisabled]}>
                <Text style={modalStyles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// Supabase/PostgREST errors are plain {code, message, ...} objects, never
// `instanceof Error`, so an instanceof check alone always falls through to the
// fallback and hides the real message. Same fix as vendors-panel.tsx.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const message = (err as { message: string }).message;
    if (message.includes('shop_locations_shop_id_name_key')) return 'A store with that name already exists.';
    if (message.includes('shop_locations_shop_id_code_key')) return 'Another store already uses that branch code.';
    // Raised once sales/shifts reference a location: the FK refuses the delete.
    if (message.includes('violates foreign key constraint')) {
      return 'This store has sales or shifts recorded against it. Mark it as closed instead of deleting it.';
    }
    return message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 10 },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '85%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  list: { flexGrow: 0 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  fieldLabelSpaced: { marginTop: 16 },
  fieldHint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  statusLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  statusAction: { fontSize: 12, fontWeight: '700', color: '#111111', textDecorationLine: 'underline' },
  statusHint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 6 },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  rowActionTextMuted: { fontSize: 12, fontWeight: '700', color: '#999999' },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  confirmText: { fontSize: 12, fontWeight: '600', color: '#111111' },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
