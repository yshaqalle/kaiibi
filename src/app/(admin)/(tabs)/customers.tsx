import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { useAuth } from '@/hooks/use-auth';
import { listCustomers } from '@/lib/customers';
import type { Customer } from '@/types/models';

export default function CustomersScreen() {
  const { shop } = useAuth();
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setCustomers(await listCustomers(shop.id));
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      c.firstName.toLowerCase().includes(q) ||
      (c.lastName ?? '').toLowerCase().includes(q) ||
      (c.phone ?? '').toLowerCase().includes(q) ||
      c.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [customers, search]);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Customers</Text>
            <Text style={styles.subtitle}>{customers.length} customers</Text>
          </View>
          <Pressable onPress={() => router.push('/customer/new')} style={styles.addButton}>
            <Text style={styles.addButtonText}>+ New</Text>
          </Pressable>
        </View>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, phone, or tag" placeholderTextColor="#999999" style={styles.search} />
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No customers yet. Add your first one above.</Text>
        ) : (
          <Card style={styles.list}>
            {filtered.map((customer) => (
              <Pressable key={customer.id} onPress={() => router.push(`/customer/${customer.id}`)} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{customer.firstName} {customer.lastName ?? ''}</Text>
                  {customer.phone && <Text style={styles.rowMeta}>{customer.phone}</Text>}
                </View>
                {customer.tags.length > 0 && (
                  <Text style={styles.rowTags} numberOfLines={1}>{customer.tags.slice(0, 3).join(', ')}</Text>
                )}
              </Pressable>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginTop: 18, marginBottom: 18, color: '#111111' },
  list: { overflow: 'hidden' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rowName: { color: '#111111', fontSize: 14, fontWeight: '700' },
  rowMeta: { color: '#999999', fontSize: 12, marginTop: 2 },
  rowTags: { color: '#999999', fontSize: 11, maxWidth: 140 },
});
