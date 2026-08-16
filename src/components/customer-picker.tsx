import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { customerDisplayName, customerPointsAvailable, quickAddCustomer, searchCustomers } from '@/lib/customers';
import { pointsValueLabel } from '@/lib/loyalty';
import type { Customer } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

// `pointsBalance` rides along because pos_search_customers returns whole
// customer rows, so showing a balance costs no extra query.
//
// `availablePoints` cannot: it depends on the clock and on the ledger, so it's
// fetched once when a customer is attached. Null means "not looked up yet" —
// distinct from 0, which means "nothing spendable" — so the checkout sheet can
// say so rather than flashing a wrong number while it loads.
export type SelectedCustomer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  pointsBalance: number;
  availablePoints: number | null;
};

// Re-exported name kept local so the many call sites below read unchanged;
// the rule itself now lives in lib/customers.ts, shared with global search.
const fullName = customerDisplayName;

// Supabase rpc() errors are plain {code, details, hint, message} objects,
// never instanceof Error -- checking that first always falls through to the
// fallback string and hides the real Postgres message. See pos.tsx's
// extractErrorMessage for the same fix applied to checkout.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

// Shared between pos.tsx (checkout) and sales.tsx (sale editing) -- both
// need identical search-existing-or-quick-add-new behavior, per the design
// spec's note that edit_sale's customer section "gets the same picker
// treatment ... already reuses much of the same customer-info UI as
// pos.tsx today".
export function CustomerPicker({
  shopId,
  selected,
  variant = 'link',
  onSelect,
  onClear,
  showPoints = false,
  centsPerPoint = 1,
}: {
  shopId: string;
  selected: SelectedCustomer | null;
  /**
   * `link` is the quiet text toggle a filter wants. `row` is the till's: a
   * full-width tile naming who is buying, because at a counter that is a
   * decision worth seeing from across the shop, not a footnote.
   */
  variant?: 'link' | 'row';
  onSelect: (customer: SelectedCustomer) => void;
  onClear: () => void;
  // Off by default so the sale editor, which has no redemption flow, keeps its
  // current shape.
  showPoints?: boolean;
  centsPerPoint?: number;
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
    setError(null);
    if (!text.trim()) { setResults([]); return; }
    try {
      setResults(await searchCustomers(shopId, text));
    } catch (err) {
      setResults([]);
      setError(extractErrorMessage(err, 'Could not search customers.'));
    }
  };

  const pick = (customer: Customer) => {
    const selection: SelectedCustomer = {
      id: customer.id,
      name: fullName(customer),
      phone: customer.phone,
      email: customer.email,
      pointsBalance: customer.pointsBalance,
      availablePoints: null,
    };
    onSelect(selection);
    // Resolved after the fact so attaching a customer stays instant. A failure
    // leaves it null, which the checkout sheet reads as "unknown" and offers no
    // redemption -- the safe direction, since the server would refuse anyway.
    if (showPoints) {
      customerPointsAvailable(customer.id)
        .then((available) => onSelect({ ...selection, availablePoints: available }))
        .catch(() => onSelect({ ...selection, availablePoints: 0 }));
    }
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
      setError(extractErrorMessage(err, 'Could not add this customer.'));
    } finally {
      setCreating(false);
    }
  };

  if (selected && variant === 'row') {
    const initials = selected.name.split(/\s+/).slice(0, 2).map((word) => word[0] ?? '').join('').toUpperCase();
    return (
      <Pressable onPress={onClear} style={styles.row} accessibilityLabel={`Remove ${selected.name}`}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={1}>{selected.name}</Text>
          <Text style={styles.rowSub} numberOfLines={1}>
            {[selected.phone, showPoints && selected.pointsBalance > 0
              ? pointsValueLabel(selected.pointsBalance, centsPerPoint)
              : null].filter(Boolean).join(' · ') || 'Tap to remove'}
          </Text>
        </View>
        <Text style={styles.rowChevron}>✕</Text>
      </Pressable>
    );
  }

  if (selected) {
    return (
      <View style={styles.selectedRow}>
        <Text style={styles.selectedText}>
          Customer: {selected.name}
          {showPoints && selected.pointsBalance > 0 ? ` · ${pointsValueLabel(selected.pointsBalance, centsPerPoint)}` : ''}
        </Text>
        <Pressable onPress={onClear}><Text style={styles.clear}>Clear</Text></Pressable>
      </View>
    );
  }

  return (
    <View>
      {variant === 'row' ? (
        <Pressable onPress={() => setOpen((v) => !v)} style={styles.row}>
          <View style={[styles.avatar, styles.avatarWalkIn]}><Text style={styles.avatarWalkInText}>⌕</Text></View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Walk-in customer</Text>
            <Text style={styles.rowSub} numberOfLines={1}>Attach one for points and a saved receipt</Text>
          </View>
          <Text style={styles.rowChevron}>{open ? '⌃' : '›'}</Text>
        </Pressable>
      ) : (
        <Pressable onPress={() => setOpen((v) => !v)} style={styles.toggle}>
          <Text style={styles.toggleText}>{open ? '▴' : '▾'} Add customer (optional)</Text>
        </Pressable>
      )}
      {open && (
        <View style={styles.panel}>
          <TextInput value={query} onChangeText={runSearch} placeholder="Search by name or phone…" placeholderTextColor="#9B9B9B" style={styles.input} />
          {!quickAdd && error && <Text style={styles.error}>{error}</Text>}
          {results.map((customer) => (
            <Pressable key={customer.id} onPress={() => pick(customer)} style={styles.resultRow}>
              <Text style={styles.resultName}>{fullName(customer)}</Text>
              {(customer.phone || (showPoints && customer.pointsBalance > 0)) && (
                <Text style={styles.resultMeta}>
                  {[customer.phone, showPoints && customer.pointsBalance > 0 ? pointsValueLabel(customer.pointsBalance, centsPerPoint) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              )}
            </Pressable>
          ))}
          {!quickAdd ? (
            <Pressable onPress={() => { setQuickAdd(true); setError(null); }} style={styles.quickAddToggle}>
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
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 12,
    backgroundColor: theme.bentoSoft, borderRadius: BENTO_RADIUS_TILE, paddingVertical: 11, paddingHorizontal: 12,
  },
  avatar: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: theme.bentoInk,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: theme.bentoSurface, fontSize: 12, fontWeight: '800' },
  avatarWalkIn: { backgroundColor: theme.bentoSurface },
  avatarWalkInText: { color: theme.bentoMuted2, fontSize: 16 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { color: theme.bentoInk, fontSize: 13.5, fontWeight: '700' },
  rowSub: { color: theme.bentoMuted, fontSize: 11.5, marginTop: 1 },
  rowChevron: { color: theme.bentoMuted2, fontSize: 15, fontWeight: '700' },
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
