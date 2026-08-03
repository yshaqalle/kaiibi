import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { createVendor, searchVendors } from '@/lib/vendors';
import type { Vendor } from '@/types/models';

export type SelectedVendor = { id: string; name: string };

// Search-existing-or-quick-add, same shape as CustomerPicker (which POS
// checkout and sale editing already share). Shared here between the expense
// editor and, later, the vendor-bill editor: recording a purchase from a new
// supplier shouldn't require abandoning the form for Settings.
//
// The quick-add captures only name/contact/phone/email; address and notes are
// left to the full editor in Settings → Store → Vendors, which manages the
// same rows.
export function VendorPicker({
  shopId,
  selected,
  onSelect,
  onClear,
  label = 'Vendor (optional)',
}: {
  shopId: string;
  selected: SelectedVendor | null;
  onSelect: (vendor: SelectedVendor) => void;
  onClear: () => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Vendor[]>([]);
  const [quickAdd, setQuickAdd] = useState(false);
  const [name, setName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (text: string) => {
    setQuery(text);
    setError(null);
    if (!text.trim()) {
      setResults([]);
      return;
    }
    try {
      setResults(await searchVendors(shopId, text));
    } catch (err) {
      setResults([]);
      setError(extractErrorMessage(err, 'Could not search vendors.'));
    }
  };

  const pick = (vendor: Vendor | SelectedVendor) => {
    onSelect({ id: vendor.id, name: vendor.name });
    setOpen(false);
    setQuery('');
    setResults([]);
    setQuickAdd(false);
  };

  const submitQuickAdd = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const vendor = await createVendor(shopId, {
        name: name.trim(),
        contactPerson: contactPerson.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: null,
        notes: null,
      });
      pick(vendor);
      setName('');
      setContactPerson('');
      setPhone('');
      setEmail('');
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not add this vendor.'));
    } finally {
      setCreating(false);
    }
  };

  if (selected) {
    return (
      <View style={styles.selectedRow}>
        <Text style={styles.selectedText} numberOfLines={1}>Vendor: {selected.name}</Text>
        <Pressable onPress={onClear}><Text style={styles.clear}>Clear</Text></Pressable>
      </View>
    );
  }

  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.toggle}>
        <Text style={styles.toggleText}>{open ? '▴' : '▾'} {label}</Text>
      </Pressable>
      {open && (
        <View style={styles.panel}>
          <TextInput
            value={query}
            onChangeText={runSearch}
            placeholder="Search vendors…"
            placeholderTextColor="#9B9B9B"
            style={styles.input}
          />
          {!quickAdd && error && <Text style={styles.error}>{error}</Text>}
          {results.map((vendor) => (
            <Pressable key={vendor.id} onPress={() => pick(vendor)} style={styles.resultRow}>
              <Text style={styles.resultName}>{vendor.name}</Text>
              {(vendor.contactPerson || vendor.phone) && (
                <Text style={styles.resultMeta}>{[vendor.contactPerson, vendor.phone].filter(Boolean).join(' · ')}</Text>
              )}
            </Pressable>
          ))}
          {!quickAdd && query.trim() && results.length === 0 && !error && (
            <Text style={styles.resultMeta}>No vendors match “{query.trim()}”.</Text>
          )}
          {!quickAdd ? (
            <Pressable onPress={() => { setQuickAdd(true); setError(null); setName(query.trim()); }} style={styles.quickAddToggle}>
              <Text style={styles.quickAddToggleText}>+ New vendor</Text>
            </Pressable>
          ) : (
            <View style={styles.quickAddForm}>
              <TextInput value={name} onChangeText={setName} placeholder="Vendor name" placeholderTextColor="#9B9B9B" style={styles.input} />
              <TextInput value={contactPerson} onChangeText={setContactPerson} placeholder="Contact person" placeholderTextColor="#9B9B9B" style={styles.input} />
              <TextInput value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor="#9B9B9B" keyboardType="phone-pad" style={styles.input} />
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="Email"
                placeholderTextColor="#9B9B9B"
                keyboardType="email-address"
                autoCapitalize="none"
                style={styles.input}
              />
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable
                onPress={submitQuickAdd}
                disabled={!name.trim() || creating}
                style={[styles.quickAddSubmit, (!name.trim() || creating) && styles.quickAddSubmitDisabled]}
              >
                <Text style={styles.quickAddSubmitText}>{creating ? 'Adding…' : 'Add vendor'}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// Supabase rpc/PostgREST errors are plain {code, message, ...} objects, never
// `instanceof Error` -- checking that first always falls through to the
// fallback and hides the real message. Same fix as customer-picker.tsx.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const message = (err as { message: string }).message;
    if (message.includes('vendors_shop_id_name_key')) return 'A vendor with that name already exists.';
    return message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  toggle: { paddingVertical: 4 },
  toggleText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  panel: { gap: 8, marginTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  resultRow: { paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  resultName: { color: '#111111', fontSize: 13, fontWeight: '700' },
  resultMeta: { color: '#999999', fontSize: 11, marginTop: 1 },
  quickAddToggle: { paddingVertical: 8 },
  quickAddToggleText: { color: '#111111', fontSize: 12, fontWeight: '700' },
  quickAddForm: { gap: 8, marginTop: 4 },
  quickAddSubmit: { backgroundColor: '#111111', height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  quickAddSubmitDisabled: { backgroundColor: '#CCCCCC' },
  quickAddSubmitText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  selectedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  selectedText: { fontSize: 12, fontWeight: '700', color: '#111111', flexShrink: 1 },
  clear: { fontSize: 12, fontWeight: '700', color: '#999999' },
  error: { color: '#C0392B', fontSize: 11, fontWeight: '700' },
});
