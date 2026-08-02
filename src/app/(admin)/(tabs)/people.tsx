import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { CategoryChip } from '@/components/category-chip';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { CustomerModal } from '@/components/customer-modal';
import { ExportMenu } from '@/components/export-menu';
import { NotesField } from '@/components/notes-field';
import { SegmentedControl } from '@/components/segmented-control';
import { StatTile } from '@/components/stat-tile';
import { TwoPaneListDetail } from '@/components/two-pane-list-detail';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatCents } from '@/lib/currency';
import { CUSTOMER_SEGMENT_LABELS, segmentForCustomer, type CustomerSegment } from '@/lib/customer-segments';
import { createCustomer, getCustomerStats, getCustomersStatsBatch, listCustomerPurchases, listCustomers, updateCustomer } from '@/lib/customers';
import { CUSTOMERS_EXAMPLE_ROW, CUSTOMERS_TEMPLATE_COLUMNS, runCustomersImport } from '@/lib/customers-import';
import { openWhatsApp } from '@/lib/whatsapp';
import type { Customer, CustomerPurchase } from '@/types/models';

type PeopleTab = 'customers' | 'team';

const TEAM_PERMISSIONS = ['staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'] as const;

const CUSTOMER_EXPORT_COLUMNS: CsvColumn<Customer>[] = [
  { header: 'First Name', value: (c) => c.firstName },
  { header: 'Last Name', value: (c) => c.lastName ?? '' },
  { header: 'Email', value: (c) => c.email ?? '' },
  { header: 'Phone', value: (c) => c.phone ?? '' },
  { header: 'Street', value: (c) => c.street ?? '' },
  { header: 'City', value: (c) => c.city ?? '' },
  { header: 'Neighborhood', value: (c) => c.neighborhood ?? '' },
  { header: 'Tags', value: (c) => c.tags.join('; ') },
  { header: 'Notes', value: (c) => c.notes ?? '' },
];

export default function PeopleScreen() {
  const { can, canAny } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  const canSeeCustomers = can('customers.view');
  const canSeeTeam = canAny([...TEAM_PERMISSIONS]);
  const [tab, setTab] = useState<PeopleTab>(canSeeCustomers ? 'customers' : 'team');

  const options = [
    ...(canSeeCustomers ? [{ key: 'customers' as const, label: 'Customers' }] : []),
    ...(canSeeTeam ? [{ key: 'team' as const, label: 'Team' }] : []),
  ];

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.title}>People</Text>
        {options.length > 1 && <SegmentedControl options={options} value={tab} onChange={setTab} />}
      </View>
      <View style={styles.body}>
        {tab === 'customers' && canSeeCustomers ? <CustomersTab compact={compact} /> : null}
        {tab === 'team' && canSeeTeam ? <TeamTab compact={compact} /> : null}
      </View>
    </SafeAreaView>
  );
}

// Placeholder bodies -- Task 11 replaces CustomersTab (list+detail, filter
// chips, notes, purchase history) and Task 12 replaces TeamTab (roster
// list+detail, payroll, shifts, access grid, time-off approvals). Kept as
// separate named components here so those tasks swap a function body
// rather than restructuring this shell.
function CustomersTab({ compact }: { compact: boolean }) {
  const { shop, can } = useAuth();
  const canEdit = can('customers.edit');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [rowStats, setRowStats] = useState<Map<string, { totalSpentCents: number; visitCount: number }>>(new Map());
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState<CustomerSegment | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    const [list, stats] = await Promise.all([listCustomers(shop.id), getCustomersStatsBatch(shop.id)]);
    setCustomers(list);
    setRowStats(stats);
    setLoading(false);
  }, [shop]);

  useEffect(() => {
    reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (segment !== 'all' && segmentForCustomer(c) !== segment) return false;
      if (!q) return true;
      return (
        c.firstName.toLowerCase().includes(q) ||
        (c.lastName ?? '').toLowerCase().includes(q) ||
        (c.phone ?? '').toLowerCase().includes(q) ||
        c.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [customers, search, segment]);

  const selected = customers.find((c) => c.id === selectedId) ?? null;

  const segmentCounts = useMemo(() => {
    const counts: Record<CustomerSegment, number> = { vip: 0, regular: 0, new: 0, 'at-risk': 0 };
    for (const c of customers) counts[segmentForCustomer(c)]++;
    return counts;
  }, [customers]);

  const importConfig: ImportEntityConfig<Customer> | null = shop
    ? {
        title: 'customers',
        filenamePrefix: 'customers',
        templateColumns: CUSTOMERS_TEMPLATE_COLUMNS,
        exampleRows: [CUSTOMERS_EXAMPLE_ROW],
        run: (parsed) => runCustomersImport(shop.id, parsed),
      }
    : null;

  const list = (
    <>
      <View style={tabStyles.search}>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, phone, or tag" placeholderTextColor="#999999" style={tabStyles.searchInput} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={tabStyles.chips}>
        <CategoryChip label={`All · ${customers.length}`} active={segment === 'all'} onPress={() => setSegment('all')} />
        {(Object.keys(CUSTOMER_SEGMENT_LABELS) as CustomerSegment[]).map((key) => (
          <CategoryChip key={key} label={`${CUSTOMER_SEGMENT_LABELS[key]} · ${segmentCounts[key]}`} active={segment === key} onPress={() => setSegment(key)} />
        ))}
      </ScrollView>
      {loading ? (
        <Text style={tabStyles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={tabStyles.empty}>No customers match.</Text>
      ) : (
        <Card style={tabStyles.list}>
          {filtered.map((customer) => {
            const stats = rowStats.get(customer.id);
            const segmentKey = segmentForCustomer(customer);
            return (
              <Pressable
                key={customer.id}
                onPress={() => setSelectedId(customer.id)}
                style={[tabStyles.row, customer.id === selectedId && tabStyles.rowSelected]}
              >
                <View style={tabStyles.rowMain}>
                  <Text style={tabStyles.rowName}>
                    {customer.firstName} {customer.lastName ?? ''}
                  </Text>
                  <Text style={tabStyles.rowSub}>
                    {stats ? `${stats.visitCount} order${stats.visitCount === 1 ? '' : 's'} · ${formatCents(stats.totalSpentCents)}` : 'No orders yet'}
                  </Text>
                </View>
                <Badge label={CUSTOMER_SEGMENT_LABELS[segmentKey]} tone={segmentKey === 'vip' ? 'danger' : segmentKey === 'at-risk' || segmentKey === 'new' ? 'warning' : 'default'} />
                {customer.phone && (
                  <Pressable onPress={() => openWhatsApp(customer.phone!)} style={tabStyles.waButton} hitSlop={6}>
                    <Text style={tabStyles.waIcon}>💬</Text>
                  </Pressable>
                )}
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );

  const detail = selected ? (
    <CustomerDetailPane customer={selected} canEdit={canEdit} onEdit={() => setEditingCustomer(selected)} onChanged={reload} />
  ) : (
    <Card style={tabStyles.emptyDetail}>
      <Text style={tabStyles.empty}>Select a customer to see their details.</Text>
    </Card>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={tabStyles.tabHeader}>
        <Text style={tabStyles.subtitle}>{customers.length} customers</Text>
        <View style={tabStyles.headerActions}>
          <ExportMenu rows={filtered} columns={CUSTOMER_EXPORT_COLUMNS} title="Customers" subtitle={`${filtered.length} customers`} filenamePrefix="customers" />
          {canEdit && (
            <Pressable onPress={() => setShowImportModal(true)} style={tabStyles.actionButton}>
              <Text style={tabStyles.actionButtonText}>Import</Text>
            </Pressable>
          )}
          {canEdit && (
            <Pressable onPress={() => setShowAddModal(true)} style={tabStyles.actionButton}>
              <Text style={tabStyles.actionButtonText}>+ New</Text>
            </Pressable>
          )}
        </View>
      </View>
      <TwoPaneListDetail compact={compact} list={list} detail={detail} />
      {shop && canEdit && (
        <CustomerModal
          visible={showAddModal}
          onClose={() => setShowAddModal(false)}
          shopId={shop.id}
          onSubmit={async (input) => {
            await createCustomer(shop.id, input);
            await reload();
          }}
        />
      )}
      {shop && canEdit && (
        <CustomerModal
          visible={editingCustomer !== null}
          onClose={() => setEditingCustomer(null)}
          shopId={shop.id}
          initial={editingCustomer ?? undefined}
          onSubmit={async (input) => {
            if (editingCustomer) await updateCustomer(editingCustomer.id, input);
            await reload();
          }}
          onDeleted={reload}
        />
      )}
      {importConfig && <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />}
    </View>
  );
}

function CustomerDetailPane({
  customer,
  canEdit,
  onEdit,
  onChanged,
}: {
  customer: Customer;
  canEdit: boolean;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}) {
  const [stats, setStats] = useState<{ totalSpentCents: number; visitCount: number; lastPurchaseAt: string | null } | null>(null);
  const [purchases, setPurchases] = useState<CustomerPurchase[]>([]);

  useEffect(() => {
    getCustomerStats(customer.id).then(setStats).catch(() => setStats(null));
    listCustomerPurchases(customer.id).then(setPurchases).catch(() => setPurchases([]));
  }, [customer.id]);

  const segment = segmentForCustomer(customer);
  const isVip = segment === 'vip';

  const toggleVip = async () => {
    const nextTags = isVip ? customer.tags.filter((t) => t.toLowerCase() !== 'vip') : [...customer.tags, 'vip'];
    await updateCustomer(customer.id, { tags: nextTags });
    await onChanged();
  };

  return (
    <Card style={tabStyles.detailCard}>
      <View style={tabStyles.detHead}>
        <Text style={tabStyles.detName}>
          {customer.firstName} {customer.lastName ?? ''}
        </Text>
        <Badge label={CUSTOMER_SEGMENT_LABELS[segment]} tone={segment === 'vip' ? 'danger' : 'default'} />
      </View>
      {customer.phone && <Text style={tabStyles.detPhone}>{customer.phone}</Text>}
      <View style={tabStyles.tiles}>
        <StatTile value={stats ? formatCents(stats.totalSpentCents) : '—'} label="Lifetime spend" />
        <StatTile value={stats ? String(stats.visitCount) : '—'} label="Orders" />
        <StatTile value={stats?.lastPurchaseAt ? new Date(stats.lastPurchaseAt).toLocaleDateString() : '—'} label="Last purchase" />
      </View>
      <View style={tabStyles.actions}>
        {customer.phone && (
          <Pressable onPress={() => openWhatsApp(customer.phone!)} style={tabStyles.actionButton}>
            <Text style={tabStyles.actionButtonText}>WhatsApp</Text>
          </Pressable>
        )}
        {canEdit && (
          <Pressable onPress={onEdit} style={tabStyles.actionButtonGhost}>
            <Text style={tabStyles.actionButtonGhostText}>Edit</Text>
          </Pressable>
        )}
        {canEdit && (
          <Pressable onPress={toggleVip} style={tabStyles.actionButtonGhost}>
            <Text style={tabStyles.actionButtonGhostText}>{isVip ? 'Remove VIP' : 'Mark VIP'}</Text>
          </Pressable>
        )}
      </View>
      <View style={tabStyles.section}>
        <Text style={tabStyles.sectionTitle}>NOTES</Text>
        <NotesField key={customer.id} value={customer.notes} onSave={async (notes) => { await updateCustomer(customer.id, { notes }); await onChanged(); }} />
      </View>
      <View style={tabStyles.section}>
        <Text style={tabStyles.sectionTitle}>PURCHASE HISTORY</Text>
        {purchases.length === 0 ? (
          <Text style={tabStyles.empty}>No purchases yet.</Text>
        ) : (
          purchases.map((p) => (
            <View key={p.saleItemId} style={tabStyles.histRow}>
              <View style={{ flex: 1 }}>
                <Text style={tabStyles.histTitle}>
                  {p.productName}
                  {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                </Text>
                <Text style={tabStyles.histMeta}>
                  {new Date(p.createdAt).toLocaleDateString()} · {p.paymentMethod}
                </Text>
              </View>
              <Text style={tabStyles.histAmount}>{formatCents(p.lineTotalCents)}</Text>
            </View>
          ))
        )}
      </View>
    </Card>
  );
}

function TeamTab({ compact }: { compact: boolean }) {
  return <Text style={styles.placeholder}>Team — coming in Task 12.</Text>;
}

const tabStyles = StyleSheet.create({
  tabHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  subtitle: { color: '#999999', fontSize: 12 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  actionButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  actionButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  actionButtonGhost: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  actionButtonGhostText: { color: '#111111', fontWeight: '800', fontSize: 11 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginBottom: 10 },
  searchInput: { flex: 1, height: '100%', color: '#111111' },
  chips: { gap: 6, paddingBottom: 12 },
  list: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 13, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  rowSelected: { backgroundColor: '#F7E1E2' },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13.5, fontWeight: '700', color: '#111111' },
  rowSub: { fontSize: 11.5, color: '#999999', marginTop: 2 },
  waButton: { width: 28, height: 28, borderRadius: 8, backgroundColor: '#E1F0E4', alignItems: 'center', justifyContent: 'center' },
  waIcon: { fontSize: 13 },
  empty: { color: '#999999', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  emptyDetail: { padding: 24, alignItems: 'center' },
  detailCard: { padding: 18 },
  detHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  detName: { fontSize: 17, fontWeight: '800', color: '#111111' },
  detPhone: { fontSize: 12.5, color: '#666666', marginBottom: 16 },
  tiles: { flexDirection: 'row', gap: 9, marginBottom: 16 },
  actions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 18 },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, color: '#999999', marginBottom: 8 },
  histRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#ECECEC', gap: 10 },
  histTitle: { fontSize: 12.5, fontWeight: '600', color: '#111111' },
  histMeta: { fontSize: 11, color: '#999999', marginTop: 1 },
  histAmount: { fontSize: 12.5, fontWeight: '700', color: '#111111' },
});

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { paddingHorizontal: 24, paddingTop: 24 },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5, marginBottom: 14 },
  body: { flex: 1, paddingHorizontal: 24, paddingBottom: 24 },
  placeholder: { color: '#999999', fontSize: 13 },
});
