import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { OpeningHoursEditor } from '@/components/settings/opening-hours-editor';
import { Badge, Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { useAuth } from '@/hooks/use-auth';
import { toCents } from '@/lib/currency';
import { describePlanError } from '@/lib/entitlements';
import { createLocation, deleteLocation, setPrimaryLocation, updateLocation } from '@/lib/locations';
import { DAY_LABELS, WEEK_ORDER, findDayProblem, normalizeHours, rangesFor, type OpeningHours } from '@/lib/store-hours';
import type { NewShopLocationInput, ShopLocation } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

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
  const { limitFor, usageOf } = useAuth();

  // Opening another branch is the clearest reason to move up a tier, so this
  // is the one cap worth stating before it's hit rather than after. The
  // database trigger is the real gate (migration 20260818000300) -- this only
  // stops the UI offering something the server will refuse.
  const storeLimit = limitFor('locations');
  const atStoreLimit = storeLimit != null && usageOf('locations') >= storeLimit;

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
        {atStoreLimit && (
          <Text style={styles.limitNote}>
            Your plan includes {storeLimit === 1 ? 'one store' : `${storeLimit} stores`}. Upgrade in Plan and billing to
            open another — everything you already have stays exactly as it is.
          </Text>
        )}
        <View style={styles.actionsRow}>
          <Btn onPress={() => setEditing('new')} disabled={atStoreLimit}>
            New store
          </Btn>
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
  const [zaadMerchantId, setZaadMerchantId] = useState(location?.zaadMerchantId ?? '');
  const [edahabMerchantId, setEdahabMerchantId] = useState(location?.edahabMerchantId ?? '');
  const [openingHours, setOpeningHours] = useState<OpeningHours>(location?.openingHours ?? {});
  const [goalInput, setGoalInput] = useState(
    location?.monthlyRevenueGoalCents != null ? String(location.monthlyRevenueGoalCents / 100) : ''
  );
  const [active, setActive] = useState(location?.active ?? true);
  // Defaults match the column defaults, so a brand-new store behaves the same
  // whether it was created here or straight in the database.
  const [barcodeScanningEnabled, setBarcodeScanningEnabled] = useState(location?.barcodeScanningEnabled ?? true);
  const [hardwareScannerEnabled, setHardwareScannerEnabled] = useState(location?.hardwareScannerEnabled ?? false);
  const [requireOpenRegister, setRequireOpenRegister] = useState(location?.requireOpenRegister ?? false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The main location can't be closed — it's the fallback every session falls
  // back to, so deactivating it would leave a shop with nothing to sell from.
  const canDeactivate = !location?.isPrimary;
  const canSave = Boolean(name.trim()) && !saving;

  const save = async () => {
    if (!canSave) return;
    // Hours the rest of the app can't interpret must not reach the database:
    // a backwards range, or two blocks of a split day claiming the same minute.
    // Naming the day matters -- with seven collapsed rows, "invalid hours"
    // alone leaves the owner opening each one to find it. The precise reason
    // lives inside the day, where the editor shows it against the block at
    // fault. Carried over from StorePanel, which owned hours before migration
    // 20260809000000 moved them onto the location.
    const badDay = WEEK_ORDER.find((day) => findDayProblem(rangesFor(openingHours, day)));
    if (badDay) {
      setError(`${DAY_LABELS[badDay]}'s hours need fixing — tap that day to see what's wrong.`);
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
        // Trimmed to null rather than saved as '': the receipt treats empty
        // and unset the same way, and storing one of each would mean two
        // states nobody can tell apart in the database.
        zaadMerchantId: zaadMerchantId.trim() || null,
        edahabMerchantId: edahabMerchantId.trim() || null,
        // The editor normalises a day as it collapses, so this is the backstop
        // for a day still open when Save is tapped -- blocks sorted, and any
        // that touch merged into one. Two blocks with no closure between them
        // would otherwise print "13:00 – 17:00, 17:00 – 21:00" on a receipt,
        // describing a break the shop never takes.
        openingHours: normalizeHours(openingHours),
        monthlyRevenueGoalCents: goalInput.trim() ? toCents(goalInput) : null,
        barcodeScanningEnabled,
        hardwareScannerEnabled,
        requireOpenRegister,
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
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
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

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>ZAAD MERCHANT ID</Text>
            <TextInput
              value={zaadMerchantId}
              onChangeText={setZaadMerchantId}
              placeholder="This store's ZAAD number"
              placeholderTextColor="#999999"
              autoCapitalize="none"
              style={modalStyles.input}
            />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>E-DAHAB MERCHANT ID</Text>
            <TextInput
              value={edahabMerchantId}
              onChangeText={setEdahabMerchantId}
              placeholder="This store's e-Dahab number"
              placeholderTextColor="#999999"
              autoCapitalize="none"
              style={modalStyles.input}
            />
            <Text style={modalStyles.fieldHint}>
              Printed on a receipt under the payment line that used it, so a customer can query the
              transfer with the carrier. Each store has its own. Leave blank to print nothing.
            </Text>

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

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>BARCODE SCANNING</Text>
            <View style={modalStyles.toggleRow}>
              <View style={modalStyles.toggleCopy}>
                <Text style={modalStyles.toggleTitle}>Scan with the camera</Text>
                <Text style={modalStyles.toggleHint}>
                  Adds a Scan button to the register and to Inventory, for phones and tablets.
                </Text>
              </View>
              <Switch value={barcodeScanningEnabled} onValueChange={setBarcodeScanningEnabled} />
            </View>
            <View style={modalStyles.toggleRow}>
              <View style={modalStyles.toggleCopy}>
                <Text style={modalStyles.toggleTitle}>This store has a barcode scanner</Text>
                <Text style={modalStyles.toggleHint}>
                  For the USB or Bluetooth kind that plugs into the till. Turn this on only if one is connected here —
                  it makes the register watch the keyboard for scans.
                </Text>
              </View>
              <Switch value={hardwareScannerEnabled} onValueChange={setHardwareScannerEnabled} />
            </View>

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>REGISTERS</Text>
            <View style={modalStyles.toggleRow}>
              <View style={modalStyles.toggleCopy}>
                <Text style={modalStyles.toggleTitle}>Require an open register to sell</Text>
                <Text style={modalStyles.toggleHint}>
                  This store counts its drawer at the start and end of every session, and the register refuses a sale
                  until someone has opened one. Leave it off and the register still works exactly as it does now —
                  sales just are not tied to a till. Add the tills themselves under Settings → Registers.
                </Text>
              </View>
              <Switch value={requireOpenRegister} onValueChange={setRequireOpenRegister} />
            </View>

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
    </AppModal>
  );
}

// Supabase/PostgREST errors are plain {code, message, ...} objects, never
// `instanceof Error`, so an instanceof check alone always falls through to the
// fallback and hides the real message. Same fix as vendors-panel.tsx.
function extractErrorMessage(err: unknown, fallback: string): string {
  // A plan cap or an un-included module is a specific, actionable failure with
  // its own copy — checked before the generic branch so it never surfaces as
  // the bare word "limit_reached".
  const planError = describePlanError(err);
  if (planError) return planError;
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
  limitNote: { color: '#9A6412', fontSize: 12, lineHeight: 18, marginTop: 10, marginBottom: 2 },
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
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  toggleCopy: { flex: 1 },
  toggleTitle: { fontSize: 13, fontWeight: '700', color: '#111111' },
  toggleHint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 3 },
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
