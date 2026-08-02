import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { CustomerModal } from '@/components/customer-modal';
import { CustomerTableHeader, CustomerTableRow, type SortDirection, type SortField } from '@/components/customer-table-row';
import { ExportMenu } from '@/components/export-menu';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { createCustomer, listCustomers, updateCustomer } from '@/lib/customers';
import { CUSTOMERS_EXAMPLE_ROW, CUSTOMERS_TEMPLATE_COLUMNS, runCustomersImport } from '@/lib/customers-import';
import type { Customer } from '@/types/models';

const CUSTOMER_EXPORT_COLUMNS: CsvColumn<Customer>[] = [
  { header: 'First Name', value: (c) => c.firstName },
  { header: 'Last Name', value: (c) => c.lastName ?? '' },
  { header: 'Email', value: (c) => c.email ?? '' },
  { header: 'Phone', value: (c) => c.phone ?? '' },
  { header: 'Street', value: (c) => c.street ?? '' },
  { header: 'City', value: (c) => c.city ?? '' },
  { header: 'Neighborhood', value: (c) => c.neighborhood ?? '' },
  { header: 'Tags', value: (c) => c.tags.join('; ') },
];

export default function CustomersScreen() {
  const { shop, can } = useAuth();
  // `customers.view` is a read-only directory; adding/editing/deleting a
  // record needs `customers.edit`, matching the customers write policies.
  const canEdit = can('customers.edit');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setCustomers(await listCustomers(shop.id));
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = !q
      ? customers
      : customers.filter((c) =>
          c.firstName.toLowerCase().includes(q) ||
          (c.lastName ?? '').toLowerCase().includes(q) ||
          (c.phone ?? '').toLowerCase().includes(q) ||
          c.tags.some((tag) => tag.toLowerCase().includes(q))
        );
    if (!sortField) return matches;
    const dir = sortDirection === 'asc' ? 1 : -1;
    return [...matches].sort((a, b) => {
      switch (sortField) {
        case 'name': return `${a.firstName} ${a.lastName ?? ''}`.localeCompare(`${b.firstName} ${b.lastName ?? ''}`) * dir;
        case 'phone': return (a.phone ?? '').localeCompare(b.phone ?? '') * dir;
        case 'email': return (a.email ?? '').localeCompare(b.email ?? '') * dir;
      }
    });
  }, [customers, search, sortField, sortDirection]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const importConfig: ImportEntityConfig<Customer> | null = shop
    ? {
        title: 'customers',
        filenamePrefix: 'customers',
        templateColumns: CUSTOMERS_TEMPLATE_COLUMNS,
        exampleRows: [CUSTOMERS_EXAMPLE_ROW],
        run: (parsed) => runCustomersImport(shop.id, parsed),
      }
    : null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Customers</Text>
            <Text style={styles.subtitle}>{customers.length} customers</Text>
          </View>
          <View style={styles.headerActions}>
            <ExportMenu rows={filtered} columns={CUSTOMER_EXPORT_COLUMNS} title="Customers" subtitle={`${filtered.length} customers`} filenamePrefix="customers" />
            {canEdit && (
              <Pressable onPress={() => setShowImportModal(true)} style={styles.importButton}>
                <Text style={styles.importButtonText}>Import</Text>
              </Pressable>
            )}
            {canEdit && (
              <Pressable onPress={() => setShowAddModal(true)} style={styles.addButton}>
                <Text style={styles.addButtonText}>+ New</Text>
              </Pressable>
            )}
          </View>
        </View>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, phone, or tag" placeholderTextColor="#999999" style={styles.search} />
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No customers yet. Add your first one above.</Text>
        ) : (
          <Card style={styles.list}>
            <CustomerTableHeader sortField={sortField} sortDirection={sortDirection} onSort={toggleSort} />
            {filtered.map((customer) => (
              <CustomerTableRow key={customer.id} customer={customer} onEdit={canEdit ? () => setEditingCustomer(customer) : undefined} />
            ))}
          </Card>
        )}
      </ScrollView>

      {shop && canEdit && (
        <CustomerModal
          visible={showAddModal}
          onClose={() => setShowAddModal(false)}
          shopId={shop.id}
          onSubmit={async (input) => { await createCustomer(shop.id, input); await reload(); }}
        />
      )}
      {shop && canEdit && (
        <CustomerModal
          visible={editingCustomer !== null}
          onClose={() => setEditingCustomer(null)}
          shopId={shop.id}
          initial={editingCustomer ?? undefined}
          onSubmit={async (input) => { if (editingCustomer) await updateCustomer(editingCustomer.id, input); await reload(); }}
          onDeleted={reload}
        />
      )}
      {importConfig && (
        <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  importButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  importButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginTop: 18, marginBottom: 18, color: '#111111' },
  list: { overflow: 'hidden' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
