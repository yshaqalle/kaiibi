import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { quickAddCustomer, searchCustomers } from '@/lib/customers';
import type { Customer } from '@/types/models';

export type SelectedCustomer = { id: string; name: string; phone: string | null; email: string | null };

function fullName(c: Customer): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}

// Shared between pos.tsx (checkout) and sales.tsx (sale editing) -- both
// need identical search-existing-or-quick-add-new behavior, per the design
// spec's note that edit_sale's customer section "gets the same picker
// treatment ... already reuses much of the same customer-info UI as
// pos.tsx today".
export function CustomerPicker({
  shopId,
  selected,
  onSelect,
  onClear,
}: {
  shopId: string;
  selected: SelectedCustomer | null;
  onSelect: (customer: SelectedCustomer) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [quickAdd, setQuickAdd] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (text: string) => {
    setQuery(text);
    if (!text.trim()) { setResults([]); return; }
    try {
      setResults(await searchCustomers(shopId, text));
    } catch {
      setResults([]);
    }
  };

  const pick = (customer: Customer) => {
    onSelect({ id: customer.id, name: fullName(customer), phone: customer.phone, email: customer.email });
    setOpen(false);
    setQuery('');
    setResults([]);
    setQuickAdd(false);
  };

  const submitQuickAdd = async () => {
    if (!firstName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const customer = await quickAddCustomer(shopId, {
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
      });
      pick(customer);
      setFirstName('');
      setLastName('');
      setPhone('');
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this customer.');
    } finally {
      setCreating(false);
    }
  };

  if (selected) {
    return (
      <View style={styles.selectedRow}>
        <Text style={styles.selectedText}>Customer: {selected.name}</Text>
        <Pressable onPress={onClear}><Text style={styles.clear}>Clear</Text></Pressable>
      </View>
    );
  }

  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.toggle}>
        <Text style={styles.toggleText}>{open ? '▴' : '▾'} Add customer (optional)</Text>
      </Pressable>
      {open && (
        <View style={styles.panel}>
          <TextInput value={query} onChangeText={runSearch} placeholder="Search by name or phone…" placeholderTextColor="#9B9B9B" style={styles.input} />
          {results.map((customer) => (
            <Pressable key={customer.id} onPress={() => pick(customer)} style={styles.resultRow}>
              <Text style={styles.resultName}>{fullName(customer)}</Text>
              {customer.phone && <Text style={styles.resultMeta}>{customer.phone}</Text>}
            </Pressable>
          ))}
          {!quickAdd ? (
            <Pressable onPress={() => setQuickAdd(true)} style={styles.quickAddToggle}>
              <Text style={styles.quickAddToggleText}>+ New customer</Text>
            </Pressable>
          ) : (
            <View style={styles.quickAddForm}>
              <TextInput value={firstName} onChangeText={setFirstName} placeholder="First name" placeholderTextColor="#9B9B9B" style={styles.input} />
              <TextInput value={lastName} onChangeText={setLastName} placeholder="Last name" placeholderTextColor="#9B9B9B" style={styles.input} />
              <TextInput value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor="#9B9B9B" keyboardType="phone-pad" style={styles.input} />
              <TextInput value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor="#9B9B9B" keyboardType="email-address" autoCapitalize="none" style={styles.input} />
              {error && <Text style={styles.error}>{error}</Text>}
              <Pressable onPress={submitQuickAdd} disabled={!firstName.trim() || creating} style={[styles.quickAddSubmit, (!firstName.trim() || creating) && styles.quickAddSubmitDisabled]}>
                <Text style={styles.quickAddSubmitText}>{creating ? 'Adding…' : 'Add customer'}</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { paddingVertical: 4, marginTop: 14 },
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
  selectedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 },
  selectedText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  clear: { fontSize: 12, fontWeight: '700', color: '#999999' },
  error: { color: '#C0392B', fontSize: 11, fontWeight: '700' },
});
