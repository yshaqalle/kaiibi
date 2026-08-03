import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { createVendor, deleteVendor, updateVendor } from '@/lib/vendors';
import type { NewVendorInput, Vendor } from '@/types/models';

// The full-detail vendor list. A cut-down "+ New vendor" quick-add also lives
// on the expense editor (see vendor-picker.tsx) so recording a purchase
// doesn't require a detour through Settings -- it writes to the same table,
// so anything added there shows up here for editing.
//
// Follows RolesPanel's shape: one modal handles both add and edit via an
// `editing: Vendor | 'new' | null` state var.

export function VendorsPanel({
  shopId,
  vendors,
  onChange,
}: {
  shopId: string;
  vendors: Vendor[];
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Vendor | 'new' | null>(null);

  const close = () => setEditing(null);

  return (
    <View>
      <PageHeader title="Vendors" />
      <Section title={`Vendors · ${vendors.length}`}>
        <Text style={styles.hint}>
          Suppliers and anyone else the shop pays. Pick a vendor when logging an expense to keep spending grouped by who it went to.
        </Text>
        {vendors.length === 0 ? (
          <Text style={styles.empty}>No vendors yet — add one to start tracking who you buy from.</Text>
        ) : (
          vendors.map((vendor) => (
            <Row key={vendor.id} label={vendor.name} desc={describeVendor(vendor)}>
              <Btn onPress={() => setEditing(vendor)}>Edit</Btn>
            </Row>
          ))
        )}
        <View style={styles.actionsRow}>
          <Btn onPress={() => setEditing('new')}>New vendor</Btn>
        </View>
      </Section>

      {/* Mounted only while editing, and keyed by which vendor — so the form
          fields initialise straight from props on open instead of needing an
          effect to sync them back into state on every change of `editing`. */}
      {editing !== null && (
        <VendorEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          vendor={editing === 'new' ? null : editing}
          onClose={close}
          onSave={async (input) => {
            if (editing !== 'new') await updateVendor(editing.id, input);
            else await createVendor(shopId, input);
            await onChange();
            close();
          }}
          onDelete={
            editing !== 'new'
              ? async () => {
                  await deleteVendor(editing.id);
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

// Contact details are what makes a vendor row useful at a glance; fall back to
// the address, then to nothing rather than showing an empty separator.
function describeVendor(vendor: Vendor): string | undefined {
  const contact = [vendor.contactPerson, vendor.phone].filter(Boolean).join(' · ');
  return contact || vendor.email || vendor.address || undefined;
}

function VendorEditorModal({
  vendor,
  onClose,
  onSave,
  onDelete,
}: {
  vendor: Vendor | null;
  onClose: () => void;
  onSave: (input: NewVendorInput) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(vendor?.name ?? '');
  const [contactPerson, setContactPerson] = useState(vendor?.contactPerson ?? '');
  const [phone, setPhone] = useState(vendor?.phone ?? '');
  const [email, setEmail] = useState(vendor?.email ?? '');
  const [address, setAddress] = useState(vendor?.address ?? '');
  const [notes, setNotes] = useState(vendor?.notes ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canSave = Boolean(name.trim()) && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        contactPerson: contactPerson.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
      });
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this vendor.'));
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
      setError(extractErrorMessage(err, 'Could not delete this vendor.'));
      setSaving(false);
    }
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>{vendor ? 'Edit vendor' : 'New vendor'}</Text>
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
            <Text style={modalStyles.fieldLabel}>NAME</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Nairobi Beauty Distributors"
              placeholderTextColor="#999999"
              style={modalStyles.input}
            />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>CONTACT PERSON</Text>
            <TextInput value={contactPerson} onChangeText={setContactPerson} placeholder="Who you deal with" placeholderTextColor="#999999" style={modalStyles.input} />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>PHONE</Text>
            <TextInput value={phone} onChangeText={setPhone} placeholder="Phone number" placeholderTextColor="#999999" keyboardType="phone-pad" style={modalStyles.input} />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>EMAIL</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="Email address"
              placeholderTextColor="#999999"
              keyboardType="email-address"
              autoCapitalize="none"
              style={modalStyles.input}
            />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>ADDRESS</Text>
            <TextInput value={address} onChangeText={setAddress} placeholder="Where they're based" placeholderTextColor="#999999" style={modalStyles.input} />

            <Text style={[modalStyles.fieldLabel, modalStyles.fieldLabelSpaced]}>NOTES</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Payment terms, delivery days, anything worth remembering"
              placeholderTextColor="#999999"
              multiline
              textAlignVertical="top"
              style={[modalStyles.input, modalStyles.multiline]}
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={modalStyles.formActions}>
              {onDelete ? (
                confirmingDelete ? (
                  <View style={modalStyles.confirmRow}>
                    <Text style={modalStyles.confirmText}>Delete this vendor?</Text>
                    <Pressable onPress={remove} disabled={saving} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextDanger}>Confirm</Text>
                    </Pressable>
                    <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextMuted}>Cancel</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving} style={modalStyles.rowAction}>
                    <Text style={modalStyles.rowActionTextDanger}>Delete vendor</Text>
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
// fallback and hides the real message. Same fix as customer-picker.tsx.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const message = (err as { message: string }).message;
    // The unique(shop_id, name) constraint is the one error a user can
    // actually act on, and Postgres's raw text for it is unreadable.
    if (message.includes('vendors_shop_id_name_key')) return 'A vendor with that name already exists.';
    return message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  empty: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
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
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  multiline: { height: 84, paddingTop: 11 },
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
