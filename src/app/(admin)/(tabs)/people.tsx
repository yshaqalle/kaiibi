import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useDetailSelection, useHeaderActions, type DetailSelectionSetter, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { CategoryChip } from '@/components/category-chip';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { CustomerModal } from '@/components/customer-modal';
import { EditPayModal } from '@/components/edit-pay-modal';
import { ExportMenu } from '@/components/export-menu';
import { NotesField } from '@/components/notes-field';
import { ScheduleTab } from '@/components/schedule/schedule-tab';
import { StaffSelfService } from '@/components/staff-self-service';
import { StatTile } from '@/components/stat-tile';
import { TeamAddModal } from '@/components/team-add-modal';
import { TeamMemberEditModal } from '@/components/team-member-edit-modal';
import { TimeOffRequestsPanel } from '@/components/time-off-requests-panel';
import { TwoPaneListDetail } from '@/components/two-pane-list-detail';
import { Avatar } from '@/components/ui/avatar';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DetailColumns } from '@/components/ui/detail-columns';
import { GlanceStrip } from '@/components/ui/glance-strip';
import { ListCard } from '@/components/ui/list-card';
import { TabPills } from '@/components/ui/tab-pills';
import { WhatsAppButton } from '@/components/whatsapp-button';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import { useAuth } from '@/hooks/use-auth';
import type { CsvColumn } from '@/lib/csv';
import { formatCents, formatCompactCents } from '@/lib/currency';
import { CUSTOMER_SEGMENT_LABELS, segmentForCustomer, type CustomerSegment } from '@/lib/customer-segments';
import { createCustomer, getCustomersStatsBatch, getCustomerStats, listCustomerPointsHistory, listCustomerPurchases, listCustomers, updateCustomer } from '@/lib/customers';
import { CUSTOMERS_EXAMPLE_ROW, CUSTOMERS_TEMPLATE_COLUMNS, runCustomersImport } from '@/lib/customers-import';
import { groupHasAny, PERMISSION_GROUPS } from '@/lib/permission-groups';
import { listRoles, listStaff, setStaffLocations, updateStaffMember, updateStaffPay } from '@/lib/staff';
import { runStaffImport, STAFF_EXAMPLE_ROW, STAFF_TEMPLATE_COLUMNS } from '@/lib/staff-import';
import { formatPayRateLong, payRateUnitLabel } from '@/lib/pay-rate';
import { usualStore } from '@/lib/customer-segments';
import { hasMultipleLocations } from '@/lib/location-selection';
import { membersActiveToday, onLeaveMemberIds as onLeaveMembers } from '@/lib/shift-hours';
import { listShopTimeEntries, sumDurationHours } from '@/lib/time-entries';
import { listShopTimeOffRequests } from '@/lib/time-off';
import type { Customer, CustomerPointsEntry, CustomerPurchase, Role, StaffMember, TimeEntry, TimeOffRequest } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Where a member works, for display. An EMPTY set means every store — that is
// the value, not a missing one (migration 20260814000000) — so it reads as
// "All stores" rather than as nothing. Resolved by id from the store list, so a
// renamed store shows its new name everywhere.
//
// Returns null for a single-store business, where naming the only store on
// every row says nothing.
function describeMemberStores(
  locationIds: string[],
  locations: { id: string; name: string }[],
  multiStore: boolean
): string | null {
  if (!multiStore) return null;
  if (locationIds.length === 0) return 'All stores';
  const names = locationIds.map((id) => locations.find((l) => l.id === id)?.name).filter(Boolean) as string[];
  if (names.length === 0) return null;
  // Two fit; beyond that the row would grow without bound, and the exact list
  // is on the member's own detail pane.
  return names.length <= 2 ? names.join(' · ') : `${names[0]} +${names.length - 1}`;
}

type PeopleTab = 'customers' | 'team' | 'schedule' | 'me';

const TEAM_PERMISSIONS = ['staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view'] as const;

// The blurb says what the tab is FOR, matching Accounting's shell. Held here
// rather than inside each tab because the shell renders the title row above
// the tab bar, before any tab has mounted.
const TAB_BLURBS: Record<PeopleTab, { label: string; blurb: string }> = {
  customers: { label: 'Customers', blurb: 'Who shops with you, and what they are worth.' },
  team: { label: 'Team', blurb: 'Who works here, what they cost, and who is in today.' },
  schedule: { label: 'Schedule', blurb: 'Who is on, which day, at which store.' },
  me: { label: 'Me (self-service)', blurb: 'Your shifts, your hours, your time off.' },
};

// Plain-language names for the ledger's `reason` values -- 'refund_clawback'
// is what the database calls it, not what a shop owner reading the history
// should have to decode.
const POINTS_REASON_LABELS: Record<CustomerPointsEntry['reason'], string> = {
  earn: 'Earned on a sale',
  redeem: 'Spent at checkout',
  refund_clawback: 'Taken back on a refund',
  redeem_reversed: 'Returned after a refund',
  adjustment: 'Adjustment',
};

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
  { header: 'Points', value: (c) => String(c.pointsBalance) },
];

const TEAM_EXPORT_COLUMNS_BASIC: CsvColumn<StaffMember>[] = [
  { header: 'Name', value: (m) => m.fullName ?? '' },
  { header: 'Email', value: (m) => m.email ?? '' },
  { header: 'Phone', value: (m) => m.phone ?? '' },
  { header: 'Role', value: (m) => m.roleName },
  { header: 'Status', value: (m) => (m.active ? 'Active' : 'Disabled') },
  { header: 'Hire Date', value: (m) => m.hireDate ?? '' },
];

const TEAM_EXPORT_COLUMNS_WITH_PAY: CsvColumn<StaffMember>[] = [
  ...TEAM_EXPORT_COLUMNS_BASIC,
  { header: 'Pay Type', value: (m) => m.payType ?? '' },
  { header: 'Pay Rate', value: (m) => (m.payRateCents != null ? formatCents(m.payRateCents) : '') },
  // The file leaves the app and loses every bit of context that would
  // otherwise say what the number means, so the unit travels with it.
  { header: 'Pay Rate Unit', value: (m) => payRateUnitLabel(m.payType) },
  { header: 'Pay Cadence', value: (m) => m.payCadence },
];

export default function PeopleScreen() {
  const { can, canAny, myMembership } = useAuth();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;
  const canSeeCustomers = can('customers.view');
  const canSeeTeam = canAny([...TEAM_PERMISSIONS]);
  const canSeeSchedule = can('people.schedule.manage');
  const canUseSelfService = Boolean(myMembership?.active);
  // A `?tab=` param, VALIDATED against what this user may actually see. The
  // default here is permission-dependent, so a link that skipped the check
  // would land a cashier on an empty Team tab -- worse than ignoring it.
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const permittedTab = (candidate: string | undefined): PeopleTab | null => {
    if (candidate === 'customers' && canSeeCustomers) return 'customers';
    if (candidate === 'team' && canSeeTeam) return 'team';
    if (candidate === 'schedule' && canSeeSchedule) return 'schedule';
    if (candidate === 'me') return 'me';
    return null;
  };
  // Read from `?tab=` ONCE, as the initial value -- state stays authoritative
  // while mounted, so a tap never has to wait for the URL to catch up.
  const [tab, setTabState] = useState<PeopleTab>(
    permittedTab(tabParam) ?? (canSeeCustomers ? 'customers' : canSeeTeam ? 'team' : canSeeSchedule ? 'schedule' : 'me')
  );
  // ...and mirrored back out on every change, because the URL is what survives
  // a remount. The web nav shell renders two different trees either side of
  // TABLET_BREAKPOINT (admin-tabs.web.tsx), so crossing it -- resizing a window,
  // rotating a tablet -- tears this screen down and builds a new one. The
  // initializer above then reads the tab back off the URL.
  //
  // NOT a fix for the remount itself: search text, filters and the selected
  // person still reset. That has to be fixed in the shell.
  const setTab = useCallback(
    (next: PeopleTab) => {
      setTabState(next);
      router.setParams({ tab: next });
    },
    [router]
  );
  // Published by whichever tab is showing, so its buttons share the title row
  // rather than each tab rendering a title and an action bar of its own. Same
  // mechanism Accounting uses; the tabs previously each drew "People" as a
  // heading, which meant three copies of one string.
  const [headerActions, setHeaderActions] = useState<ReactNode>(null);
  // Published by whichever tab has a detail pane, so the blurb can get out of
  // the way once there is something more specific to look at.
  const [detailSelected, setDetailSelected] = useState(false);

  const options = [
    ...(canSeeCustomers ? [{ key: 'customers' as const, label: TAB_BLURBS.customers.label }] : []),
    ...(canSeeTeam ? [{ key: 'team' as const, label: TAB_BLURBS.team.label }] : []),
    ...(canSeeSchedule ? [{ key: 'schedule' as const, label: TAB_BLURBS.schedule.label }] : []),
    ...(canUseSelfService ? [{ key: 'me' as const, label: TAB_BLURBS.me.label }] : []),
  ];

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      {/* Not a ScrollView, unlike Accounting's shell: the two panes below scroll
          independently and need a bounded height to do it. The header and tab
          row stay put while the roster moves under them. */}
      <View style={styles.body}>
        <View style={styles.headerRow}>
          <View style={styles.headerTitles}>
            <Text style={styles.eyebrow}>PEOPLE</Text>
            <Text style={styles.title}>{TAB_BLURBS[tab].label}</Text>
            {!detailSelected && <Text style={styles.blurb}>{TAB_BLURBS[tab].blurb}</Text>}
          </View>
          <View style={styles.headerActions}>{headerActions}</View>
        </View>

        {options.length > 1 && (
          <View style={styles.tabBar}>
            <TabPills options={options} value={tab} onChange={setTab} />
          </View>
        )}

        {tab === 'customers' && canSeeCustomers ? <CustomersTab compact={compact} setHeaderActions={setHeaderActions} setDetailSelected={setDetailSelected} /> : null}
        {tab === 'team' && canSeeTeam ? <TeamManagementTab compact={compact} setHeaderActions={setHeaderActions} setDetailSelected={setDetailSelected} /> : null}
        {tab === 'schedule' && canSeeSchedule ? <ScheduleTab setHeaderActions={setHeaderActions} /> : null}
        {tab === 'me' && canUseSelfService && myMembership ? (
          <MeTab shopId={myMembership.shopId} member={myMembership} />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function CustomersTab({
  compact,
  setHeaderActions,
  setDetailSelected,
}: {
  compact: boolean;
  setHeaderActions: HeaderActionsSetter;
  setDetailSelected: DetailSelectionSetter;
}) {
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

  const [error, setError] = useState<string | null>(null);

  useDetailSelection(setDetailSelected, selectedId !== null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setError(null);
    try {
      const [list, stats] = await Promise.all([listCustomers(shop.id), getCustomersStatsBatch(shop.id)]);
      setCustomers(list);
      setRowStats(stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
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

  // Summed from the same batch the rows already read -- no extra query, and it
  // cannot disagree with the per-row figures beside it.
  const lifetimeSpendCents = useMemo(() => {
    let total = 0;
    for (const stats of rowStats.values()) total += stats.totalSpentCents;
    return total;
  }, [rowStats]);

  const importConfig: ImportEntityConfig<Customer> | null = shop
    ? {
        title: 'customers',
        filenamePrefix: 'customers',
        templateColumns: CUSTOMERS_TEMPLATE_COLUMNS,
        exampleRows: [CUSTOMERS_EXAMPLE_ROW],
        run: (parsed) => runCustomersImport(shop.id, parsed),
      }
    : null;

  useHeaderActions(
    setHeaderActions,
    <>
      <ExportMenu rows={filtered} columns={CUSTOMER_EXPORT_COLUMNS} title="Customers" subtitle={`${filtered.length} customers`} filenamePrefix="customers" />
      {canEdit && (
        <Pressable onPress={() => setShowImportModal(true)} style={tabStyles.actionButton}>
          <Text style={tabStyles.actionButtonText}>Import</Text>
        </Pressable>
      )}
      {canEdit && (
        <Pressable onPress={() => setShowAddModal(true)} style={[tabStyles.actionButton, tabStyles.actionButtonSolid]}>
          <Text style={[tabStyles.actionButtonText, tabStyles.actionButtonTextSolid]}>+ New</Text>
        </Pressable>
      )}
    </>,
    [filtered, canEdit]
  );

  const list = (
    <>
      {loading ? (
        <Text style={tabStyles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={tabStyles.empty}>No customers match.</Text>
      ) : (
        <Card variant="bento" style={tabStyles.list}>
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
                    {[
                      stats ? `${stats.visitCount} order${stats.visitCount === 1 ? '' : 's'} · ${formatCents(stats.totalSpentCents)}` : 'No orders yet',
                      // Only when the shop runs a programme -- a "0 pts" on
                      // every row of a shop that doesn't is pure noise.
                      shop?.loyaltyEnabled ? `${customer.pointsBalance.toLocaleString()} pts` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <View style={tabStyles.rowTrailing}>
                  <Badge
                    variant="bento"
                    label={CUSTOMER_SEGMENT_LABELS[segmentKey]}
                    tone={segmentKey === 'vip' ? 'danger' : segmentKey === 'at-risk' || segmentKey === 'new' ? 'warning' : 'default'}
                  />
                  <WhatsAppButton phone={customer.phone} name={customer.firstName} />
                </View>
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
    <BentoCard style={tabStyles.emptyDetail}>
      <Text style={tabStyles.empty}>Select a customer to see their details.</Text>
    </BentoCard>
  );

  return (
    <View style={{ flex: 1 }}>
      {error && <Text style={tabStyles.errorText}>{error}</Text>}

      {/* One low card, not a grid: four figures read as a single glance, and
          splitting them into four cells would put three gutters through one
          thought. No title -- the tile labels already say what these are, and
          the heading was 27px this screen could not spare. */}
      <GlanceStrip style={tabStyles.strip}>
        <StatTile variant="bento" density="dense" value={String(customers.length)} label="Customers" hint={`${segmentCounts.new} joined in the last 30 days`} />
        <StatTile variant="bento" density="dense" value={String(segmentCounts.vip)} label="VIPs" hint="tagged vip" />
        <StatTile variant="bento" density="dense" value={String(segmentCounts['at-risk'])} label="At risk" hint="tagged at risk" />
        <StatTile variant="bento" density="dense" value={formatCompactCents(lifetimeSpendCents)} label="Lifetime spend" hint="across every store" />
      </GlanceStrip>

      <View style={tabStyles.controlRow}>
        <View style={[tabStyles.search, tabStyles.searchInRow]}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by name, phone, or tag"
            placeholderTextColor={theme.bentoMuted2}
            style={tabStyles.searchInput}
          />
        </View>
        {/* Keeps its horizontal scroll: on a narrow window five chips will not
            fit beside the field, and wrapping them would put the row's height
            back where it started. */}
        <ScrollView horizontal style={tabStyles.filterScroll} showsHorizontalScrollIndicator={false} contentContainerStyle={tabStyles.chips}>
          <CategoryChip variant="bento" label={`All · ${customers.length}`} active={segment === 'all'} onPress={() => setSegment('all')} />
          {(Object.keys(CUSTOMER_SEGMENT_LABELS) as CustomerSegment[]).map((key) => (
            <CategoryChip variant="bento" key={key} label={`${CUSTOMER_SEGMENT_LABELS[key]} · ${segmentCounts[key]}`} active={segment === key} onPress={() => setSegment(key)} />
          ))}
        </ScrollView>
      </View>
      <TwoPaneListDetail
        compact={compact}
        list={list}
        detail={detail}
        detailOpen={selected !== null}
        onCloseDetail={() => setSelectedId(null)}
        detailTitle="Customer"
      />
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
  const [pointsHistory, setPointsHistory] = useState<CustomerPointsEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { locations, shop } = useAuth();
  const ledgerNote = useCaveatDismissal('people.customers.append-only-ledger', 'v1');
  const loyaltyOn = shop?.loyaltyEnabled ?? false;
  const multiStore = hasMultipleLocations(locations);
  // Resolved by id from the store list rather than denormalised onto the
  // purchase, so a renamed store reads correctly in old history.
  const storeNameOf = (locationId: string) =>
    multiStore ? (locations.find((l) => l.id === locationId)?.name ?? null) : null;
  const usual = multiStore ? usualStore(purchases) : null;

  useEffect(() => {
    getCustomerStats(customer.id).then(setStats).catch(() => setStats(null));
    listCustomerPurchases(customer.id).then(setPurchases).catch(() => setPurchases([]));
    if (loyaltyOn) listCustomerPointsHistory(customer.id).then(setPointsHistory).catch(() => setPointsHistory([]));
  }, [customer.id, loyaltyOn]);

  const segment = segmentForCustomer(customer);
  const isVip = segment === 'vip';

  const toggleVip = async () => {
    setError(null);
    try {
      const nextTags = isVip ? customer.tags.filter((t) => t.toLowerCase() !== 'vip') : [...customer.tags, 'vip'];
      await updateCustomer(customer.id, { tags: nextTags });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <View style={tabStyles.detailStack}>
      <BentoCard>
        {/* Name, badge, phone and the actions on ONE line. Stacked, these were
            four bands and ~64px of margin before the first figure. The row
            wraps on a long name rather than clipping, which spends the height
            back only in the case that needs it. */}
        <View style={tabStyles.detHeadRow}>
          <View style={tabStyles.detIdent}>
            <Text style={tabStyles.detName}>
              {customer.firstName} {customer.lastName ?? ''}
            </Text>
            <Badge variant="bento" label={CUSTOMER_SEGMENT_LABELS[segment]} tone={segment === 'vip' ? 'danger' : 'default'} />
            {customer.phone && <Text style={tabStyles.detMeta}>{customer.phone}</Text>}
          </View>
          <View style={tabStyles.detActions}>
            <WhatsAppButton phone={customer.phone} name={customer.firstName} variant="pill" />
            {canEdit && (
              <Pressable onPress={onEdit} style={tabStyles.actionButton}>
                <Text style={tabStyles.actionButtonText}>Edit</Text>
              </Pressable>
            )}
            {canEdit && (
              <Pressable onPress={toggleVip} style={tabStyles.actionButton}>
                <Text style={tabStyles.actionButtonText}>{isVip ? 'Remove VIP' : 'Mark VIP'}</Text>
              </Pressable>
            )}
          </View>
        </View>
        <View style={tabStyles.metricRow}>
          <StatTile variant="bento" value={stats ? formatCents(stats.totalSpentCents) : '—'} label="Lifetime spend" />
          <StatTile variant="bento" value={stats ? String(stats.visitCount) : '—'} label="Orders" />
          <StatTile variant="bento" value={stats?.lastPurchaseAt ? new Date(stats.lastPurchaseAt).toLocaleDateString() : '—'} label="Last purchase" />
          {loyaltyOn && <StatTile variant="bento" value={customer.pointsBalance.toLocaleString()} label="Points" />}
        </View>
        {error && <Text style={tabStyles.errorText}>{error}</Text>}
      </BentoCard>

      <DetailColumns
        left={
          <>
            <BentoCard title="Notes">
              <NotesField
                key={customer.id}
                value={customer.notes}
                onSave={async (notes) => { await updateCustomer(customer.id, { notes }); await onChanged(); }}
                readOnly={!canEdit}
              />
            </BentoCard>

            {/* Where they actually shop, by visit count. Hidden for a single-store
                business (nothing to distinguish) and when the history is tied or
                empty — naming a store on a 2-2 split would present a coin flip as a
                fact. See usualStore in lib/customer-segments.ts. */}
            {usual && (
              <BentoCard title="Usually shops at">
                <Text style={tabStyles.usualStore}>{storeNameOf(usual.locationId) ?? 'Unknown store'}</Text>
                <Text style={tabStyles.usualStoreMeta}>{`${usual.visits} of ${usual.totalVisits} visits`}</Text>
              </BentoCard>
            )}
          </>
        }
        right={
          <>
            <ListCard
              key={customer.id}
              title="Purchase history"
              scope={stats ? `${stats.visitCount} orders` : undefined}
              subtitle={`${customer.firstName} ${customer.lastName ?? ''}`.trim()}
              rows={purchases}
              keyExtractor={(p) => p.saleItemId}
              emptyLabel="No purchases yet."
              renderRow={(p) => (
                <View style={tabStyles.histRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={tabStyles.histTitle}>
                      {p.productName}
                      {p.quantity > 1 ? ` ×${p.quantity}` : ''}
                    </Text>
                    <Text style={tabStyles.histMeta}>
                      {new Date(p.createdAt).toLocaleDateString()} · {p.paymentMethod}
                      {storeNameOf(p.locationId) ? ` · ${storeNameOf(p.locationId)}` : ''}
                    </Text>
                  </View>
                  <Text style={tabStyles.histAmount}>{formatCents(p.lineTotalCents)}</Text>
                </View>
              )}
            />

            {/* What answers "why is my balance 148" at the counter. The ledger is
                append-only, so a correction shows up as its own row rather than
                quietly changing an old one. */}
            {loyaltyOn && (
              <ListCard
                key={customer.id}
                title="Points history"
                scope={`${customer.pointsBalance.toLocaleString()} balance`}
                subtitle={`${customer.firstName} ${customer.lastName ?? ''}`.trim()}
                rows={pointsHistory}
                keyExtractor={(entry) => entry.id}
                emptyLabel="No points activity yet."
                renderRow={(entry) => (
                  <View style={tabStyles.histRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={tabStyles.histTitle}>{POINTS_REASON_LABELS[entry.reason]}</Text>
                      <Text style={tabStyles.histMeta}>
                        {new Date(entry.createdAt).toLocaleDateString()}
                        {entry.note ? ` · ${entry.note}` : ''}
                      </Text>
                    </View>
                    <Text style={[tabStyles.histAmount, entry.deltaPoints < 0 && tabStyles.histAmountNegative]}>
                      {entry.deltaPoints > 0 ? '+' : ''}
                      {entry.deltaPoints.toLocaleString()}
                    </Text>
                  </View>
                )}
                note={
                  pointsHistory.length > 0 && !ledgerNote.dismissed ? (
                    <Caveat tone="context" onDismiss={ledgerNote.dismiss}>
                      The ledger is append-only — a correction arrives as its own row rather than quietly changing an old
                      one, which is what answers &quot;why is my balance what it is&quot; at the counter.
                    </Caveat>
                  ) : undefined
                }
              />
            )}
          </>
        }
      />
    </View>
  );
}

function MeTab({ shopId, member }: { shopId: string; member: StaffMember }) {
  const { locations } = useAuth();
  const memberStores = describeMemberStores(member.locationIds, locations, hasMultipleLocations(locations));
  return (
    <ScrollView contentContainerStyle={styles.selfServiceContent}>
      <View style={styles.selfServicePanel}>
        <BentoCard>
          <Text style={tabStyles.detName}>{member.fullName ?? member.email ?? 'Me'}</Text>
          <Text style={tabStyles.detMeta}>
            {member.roleName}
            {memberStores ? ` · ${memberStores}` : ''}
            {member.hireDate ? ` · joined ${new Date(member.hireDate).toLocaleDateString()}` : ''}
          </Text>
        </BentoCard>
        <StaffSelfService shopId={shopId} member={member} />
      </View>
    </ScrollView>
  );
}

function TeamManagementTab({
  compact,
  setHeaderActions,
  setDetailSelected,
}: {
  compact: boolean;
  setHeaderActions: HeaderActionsSetter;
  setDetailSelected: DetailSelectionSetter;
}) {
  const { shop, can, canAny, locations } = useAuth();
  const rosterStores = (member: StaffMember) =>
    describeMemberStores(member.locationIds, locations, hasMultipleLocations(locations));
  const canManageRoster = can('staff.manage');
  const canManagePayroll = can('people.payroll.manage');
  const canViewHours = canAny(['people.timesheet.view', 'people.payroll.manage']);
  const canApproveTimeOff = can('people.timeoff.approve');
  const noHoursNote = useCaveatDismissal('people.team.no-timesheet-access', 'v1');

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDetailSelection(setDetailSelected, selectedId !== null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setError(null);
    try {
      const since = new Date();
      since.setDate(1);
      since.setHours(0, 0, 0, 0);
      const [staffList, roleList, timeOffList, entryList] = await Promise.all([
        listStaff(shop.id),
        listRoles(shop.id),
        canApproveTimeOff ? listShopTimeOffRequests(shop.id) : Promise.resolve([]),
        // Shop-wide hours for the strip. Gated the same way the per-member
        // figure is: without timesheet access the tile shows a dash rather
        // than a number nobody is allowed to see.
        canViewHours ? listShopTimeEntries(shop.id, { sinceIso: since.toISOString() }) : Promise.resolve([]),
      ]);
      setStaff(staffList);
      setRoles(roleList);
      setTimeOff(timeOffList);
      setEntries(entryList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }, [shop, canApproveTimeOff, canViewHours]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Shared with the Dashboard so the two surfaces can't disagree about who's
  // off; also honours non-contiguous date ranges, which the previous inline
  // version flattened to their outer bounds.
  const onLeaveMemberIds = useMemo(() => onLeaveMembers(timeOff), [timeOff]);
  const activeTodayCount = useMemo(() => membersActiveToday(entries), [entries]);
  const hoursThisPeriod = useMemo(() => sumDurationHours(entries), [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter(
      (m) =>
        (m.fullName ?? '').toLowerCase().includes(q) ||
        m.roleName.toLowerCase().includes(q) ||
        (m.phone ?? '').toLowerCase().includes(q)
    );
  }, [staff, search]);

  const selected = staff.find((m) => m.id === selectedId) ?? null;
  const disabledCount = useMemo(() => staff.filter((m) => !m.active).length, [staff]);

  const importConfig: ImportEntityConfig<StaffMember> | null =
    shop && roles.length > 0
      ? {
          title: 'team',
          filenamePrefix: 'team',
          templateColumns: STAFF_TEMPLATE_COLUMNS,
          exampleRows: [STAFF_EXAMPLE_ROW],
          run: (parsed) => runStaffImport(shop.id, roles, parsed, canManagePayroll),
          unitLabel: 'staff member',
        }
      : null;
  // Exported pay data is sensitive -- someone who can only manage the
  // roster (staff.manage) but not payroll (people.payroll.manage) gets an
  // export without pay columns.
  // Stores are appended here rather than sitting in the module-level column
  // lists because resolving an id to a name needs `locations`. Only added for a
  // multi-store business, so a single-store export is unchanged — and it uses
  // the same wording as the screen, so an export never disagrees with what the
  // roster showed.
  const baseColumns = canManagePayroll ? TEAM_EXPORT_COLUMNS_WITH_PAY : TEAM_EXPORT_COLUMNS_BASIC;
  const exportColumns: CsvColumn<StaffMember>[] = hasMultipleLocations(locations)
    ? [
        ...baseColumns,
        {
          header: 'Stores',
          value: (m: StaffMember) =>
            m.locationIds.length === 0
              ? 'All stores'
              : m.locationIds
                  .map((id) => locations.find((l) => l.id === id)?.name)
                  .filter(Boolean)
                  .join('; '),
        },
      ]
    : baseColumns;

  useHeaderActions(
    setHeaderActions,
    <>
      {canManageRoster && <ExportMenu rows={filtered} columns={exportColumns} title="Team" subtitle={`${filtered.length} team members`} filenamePrefix="team" />}
      {canManageRoster && (
        <Pressable onPress={() => setShowImportModal(true)} style={tabStyles.actionButton}>
          <Text style={tabStyles.actionButtonText}>Import</Text>
        </Pressable>
      )}
      {canManageRoster && (
        <Pressable
          onPress={() => setShowAddModal(true)}
          disabled={roles.length === 0}
          style={[tabStyles.actionButton, tabStyles.actionButtonSolid, roles.length === 0 && tabStyles.actionButtonDisabled]}
        >
          <Text style={[tabStyles.actionButtonText, tabStyles.actionButtonTextSolid]}>+ Add staff</Text>
        </Pressable>
      )}
    </>,
    // NOT `exportColumns`: it is an array literal rebuilt on every render, so
    // depending on it would re-publish the actions every render, re-render the
    // shell that owns them, and loop. Its two real inputs are here instead —
    // `locations` is useAuth state and so is reference-stable.
    [filtered, canManageRoster, canManagePayroll, locations, roles.length]
  );

  const list = (
    <>
      {error && <Text style={tabStyles.errorText}>{error}</Text>}
      {canApproveTimeOff && <TimeOffRequestsPanel requests={timeOff} staff={staff} onChange={reload} />}
      {loading ? (
        <Text style={tabStyles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={tabStyles.empty}>No team members match.</Text>
      ) : (
        <Card variant="bento" style={tabStyles.list}>
          {filtered.map((member) => {
            const onLeave = onLeaveMemberIds.has(member.id);
            return (
              <Pressable
                key={member.id}
                onPress={() => setSelectedId(member.id)}
                style={[tabStyles.row, member.id === selectedId && tabStyles.rowSelected]}
              >
                <Avatar photoUrl={member.photoUrl} name={member.fullName} size={32} />
                <View style={tabStyles.rowMain}>
                  <Text style={tabStyles.rowName}>{member.fullName ?? member.email ?? 'Staff member'}</Text>
                  <Text style={tabStyles.rowSub}>
                    {member.roleName}
                    {rosterStores(member) ? ` · ${rosterStores(member)}` : ''}
                  </Text>
                </View>
                <View style={tabStyles.rowTrailing}>
                  <Badge
                    variant="bento"
                    label={!member.active ? 'Disabled' : onLeave ? 'On leave' : 'Active'}
                    tone={!member.active ? 'default' : onLeave ? 'warning' : 'success'}
                  />
                  <WhatsAppButton phone={member.phone} name={member.fullName ?? 'this person'} />
                </View>
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );

  const detail = selected ? (
    <TeamDetailPane
      member={selected}
      roles={roles}
      onLeave={onLeaveMemberIds.has(selected.id)}
      timeOff={timeOff}
      canManageRoster={canManageRoster}
      canManagePayroll={canManagePayroll}
      canViewHours={canViewHours}
      onChanged={reload}
    />
  ) : (
    <BentoCard style={tabStyles.emptyDetail}>
      <Text style={tabStyles.empty}>Select a team member to see their details.</Text>
    </BentoCard>
  );

  return (
    <View style={{ flex: 1 }}>
      <GlanceStrip
        style={tabStyles.strip}
        caveat={
          !canViewHours && !noHoursNote.dismissed ? (
            <Caveat tone="partial" onDismiss={noHoursNote.dismiss}>
              Hours are hidden — you don&apos;t have timesheet access, so the two figures that come from clock-ins are
              left blank rather than shown as zero.
            </Caveat>
          ) : undefined
        }
      >
        <StatTile
          variant="bento"
          density="dense"
          value={String(staff.length)}
          label="On the team"
          hint={disabledCount > 0 ? `${staff.length - disabledCount} active · ${disabledCount} disabled` : 'all active'}
        />
        <StatTile
          variant="bento"
          density="dense"
          value={canViewHours ? String(activeTodayCount) : '—'}
          label="In today"
          hint={canViewHours ? 'clocked in at some point' : 'needs timesheet access'}
        />
        <StatTile variant="bento" density="dense" value={String(onLeaveMemberIds.size)} label="On leave" hint="approved time off" />
        <StatTile
          variant="bento"
          density="dense"
          value={canViewHours ? `${hoursThisPeriod.toFixed(0)}h` : '—'}
          label="Hours this period"
          hint={canViewHours ? 'since the 1st' : 'needs timesheet access'}
        />
      </GlanceStrip>

      {/* Above the panes, not inside the list, so it does not slide off the top
          of a long roster. Matches Customers. TimeOffRequestsPanel stays in the
          pane -- it is a queue you work through, not a control you reach for. */}
      <View style={tabStyles.search}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name, role, or phone"
          placeholderTextColor={theme.bentoMuted2}
          style={tabStyles.searchInput}
        />
      </View>

      <TwoPaneListDetail
        compact={compact}
        list={list}
        detail={detail}
        detailOpen={selected !== null}
        onCloseDetail={() => setSelectedId(null)}
        detailTitle="Team member"
      />
      {shop && canManageRoster && (
        <TeamAddModal visible={showAddModal} shopId={shop.id} roles={roles} onClose={() => setShowAddModal(false)} onChange={reload} />
      )}
      {importConfig && <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />}
    </View>
  );
}

function TeamDetailPane({
  member,
  roles,
  onLeave,
  timeOff,
  canManageRoster,
  canManagePayroll,
  canViewHours,
  onChanged,
}: {
  member: StaffMember;
  roles: Role[];
  onLeave: boolean;
  timeOff: TimeOffRequest[];
  canManageRoster: boolean;
  canManagePayroll: boolean;
  canViewHours: boolean;
  onChanged: () => Promise<void>;
}) {
  const { shop, locations } = useAuth();
  // Not keyed to the member: "you don't have payroll access" is one fact about
  // the viewer, so closing it once shouldn't have to be done again on the next
  // person in the list.
  const noPayrollNote = useCaveatDismissal('people.team.no-payroll-access', 'v1');
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [editingMember, setEditingMember] = useState(false);
  const [editingPay, setEditingPay] = useState(false);
  // A pay rate is sensitive in a way a hire date is not — someone glancing at
  // a manager's screen over the counter shouldn't read it incidentally, so it
  // stays masked until asked for. TeamDetailPane isn't remounted per member
  // (no `key` at its call site, just a prop swap), so a plain useState would
  // leave the previous person's rate revealed. Reset it during render (React's
  // documented "adjusting state when a prop changes" pattern), not in a
  // useEffect, which would fire a redundant extra render.
  const [payRevealed, setPayRevealed] = useState(false);
  const [payRevealedForId, setPayRevealedForId] = useState(member.id);
  if (payRevealedForId !== member.id) {
    setPayRevealedForId(member.id);
    setPayRevealed(false);
  }

  const role = roles.find((r) => r.id === member.roleId);
  const permissions = role?.permissions ?? [];

  useEffect(() => {
    if (!shop || !canViewHours) {
      setEntries([]);
      return;
    }
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    listShopTimeEntries(shop.id, { shopMemberId: member.id, sinceIso: since.toISOString() })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [shop, member.id, canViewHours]);

  const hoursThisPeriod = sumDurationHours(entries);

  const activeLeaveRequest = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return timeOff.find(r =>
      r.shopMemberId === member.id &&
      r.status === 'approved' &&
      (r.dateRanges?.some(range => range.startDate <= today && range.endDate >= today) ?? (r.startDate <= today && r.endDate >= today))
    );
  }, [timeOff, member.id]);

  // Every range, not just the outer bounds: someone off Monday and Thursday
  // is not off on Wednesday, and flattening the two says they are.
  const leaveRanges = activeLeaveRequest
    ? (activeLeaveRequest.dateRanges?.length
        ? activeLeaveRequest.dateRanges
        : [{ startDate: activeLeaveRequest.startDate, endDate: activeLeaveRequest.endDate }])
    : [];

  const memberStores = describeMemberStores(member.locationIds, locations, hasMultipleLocations(locations));

  return (
    <View style={tabStyles.detailStack}>
      <BentoCard>
        <View style={tabStyles.detHeadRow}>
          <View style={tabStyles.detIdent}>
            <Avatar photoUrl={member.photoUrl} name={member.fullName} size={40} />
            <Text style={tabStyles.detName}>{member.fullName ?? member.email ?? 'Staff member'}</Text>
            <Badge variant="bento" label={!member.active ? 'Disabled' : onLeave ? 'On leave' : 'Active'} tone={!member.active ? 'default' : onLeave ? 'warning' : 'success'} />
            <Text style={tabStyles.detMeta}>
              {member.roleName}
              {memberStores ? ` · ${memberStores}` : ''}
              {member.phone ? ` · ${member.phone}` : ''}
              {member.hireDate ? ` · joined ${new Date(member.hireDate).toLocaleDateString()}` : ''}
            </Text>
          </View>
          {/* Messaging isn't editing: a scheduler who can see the roster but not
              change it still needs to reach the person, so the WhatsApp button is
              outside the canManageRoster gate. */}
          <View style={tabStyles.detActions}>
            <WhatsAppButton phone={member.phone} name={member.fullName ?? 'this person'} variant="pill" />
            {canManageRoster && (
              <Pressable onPress={() => setEditingMember(true)} style={tabStyles.actionButton}>
                <Text style={tabStyles.actionButtonText}>Edit member</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={tabStyles.metricRow}>
          <StatTile variant="bento" value={member.hireDate ? new Date(member.hireDate).toLocaleDateString() : '—'} label="Hire date" />
          <StatTile variant="bento" value={canManagePayroll ? (member.payType ? member.payType[0].toUpperCase() + member.payType.slice(1) : '—') : '—'} label="Pay type" />
          <StatTile variant="bento" value={canViewHours ? `${hoursThisPeriod.toFixed(1)}h` : '—'} label="Hours this period" />
        </View>

        {/* A fact about the person, not a fault to fix -- 'context', not
            'wrong'. Replaces a hand-rolled amber panel that hardcoded its own
            colours and duplicated Caveat's job. */}
        {activeLeaveRequest && (
          <Caveat tone="context">
            {`On leave — back ${new Date(activeLeaveRequest.endDate).toLocaleDateString()}. ${leaveRanges
              .map((range) => `${new Date(range.startDate).toLocaleDateString()}–${new Date(range.endDate).toLocaleDateString()}`)
              .join(', ')}${activeLeaveRequest.reason ? ` · ${activeLeaveRequest.reason}` : ''}. Requested ${new Date(
              activeLeaveRequest.requestedAt
            ).toLocaleDateString()}.`}
          </Caveat>
        )}
      </BentoCard>

      <DetailColumns
        left={
          <>
            <BentoCard
              title="Payroll"
              actions={
                canManagePayroll && !canManageRoster ? (
                  <Pressable onPress={() => setEditingPay(true)} style={tabStyles.actionButton}>
                    <Text style={tabStyles.actionButtonText}>Edit</Text>
                  </Pressable>
                ) : undefined
              }
            >
              <View style={tabStyles.payrollRow}>
                <Text style={tabStyles.payrollValue}>
                  {!canManagePayroll
                    ? 'Hidden'
                    : member.payType == null || member.payRateCents == null
                      ? 'Not set'
                      : payRevealed
                        ? formatPayRateLong(member.payType, member.payRateCents)
                        : '•••••'}
                </Text>
                {canManagePayroll && member.payType != null && member.payRateCents != null && (
                  <Pressable
                    onPress={() => setPayRevealed((prev) => !prev)}
                    style={tabStyles.actionButton}
                    accessibilityRole="button"
                    accessibilityLabel={payRevealed ? 'Hide pay rate' : 'Show pay rate'}
                  >
                    <Text style={tabStyles.actionButtonText}>{payRevealed ? 'Hide' : 'Show'}</Text>
                  </Pressable>
                )}
              </View>
              {!canManagePayroll && !noPayrollNote.dismissed && (
                <Caveat tone="partial" onDismiss={noPayrollNote.dismiss}>
                  You don&apos;t have payroll access, so this member&apos;s rate is hidden.
                </Caveat>
              )}
            </BentoCard>

            <BentoCard title="Access &amp; permissions">
              <View style={tabStyles.permGrid}>
                {PERMISSION_GROUPS.map((group) => {
                  const granted = groupHasAny(permissions, group);
                  return (
                    <View key={group.label} style={tabStyles.permTile}>
                      <View style={[tabStyles.permIcon, granted ? tabStyles.permIconOn : tabStyles.permIconOff]}>
                        <Text style={tabStyles.permIconText}>{granted ? '✓' : '🔒'}</Text>
                      </View>
                      <Text style={tabStyles.permLabel}>{group.label}</Text>
                    </View>
                  );
                })}
              </View>
            </BentoCard>
          </>
        }
        right={
          canViewHours ? (
            <ListCard
              title="Recent shifts"
              scope="This period"
              subtitle={member.fullName ?? member.email ?? 'Staff member'}
              rows={entries}
              keyExtractor={(e) => e.id}
              emptyLabel="No shifts logged this period."
              renderRow={(e) => (
                <View style={tabStyles.shiftRow}>
                  <Text style={tabStyles.shiftDate}>
                    {new Date(e.clockIn).toLocaleDateString()} · {new Date(e.clockIn).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {e.clockOut ? `–${new Date(e.clockOut).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ' (on shift)'}
                  </Text>
                  <Text style={tabStyles.shiftDuration}>{e.clockOut ? `${sumDurationHours([e]).toFixed(1)}h` : '—'}</Text>
                </View>
              )}
            />
          ) : null
        }
      />

      <EditPayModal
        visible={editingPay}
        member={member}
        onClose={() => setEditingPay(false)}
        onSave={async (patch) => {
          await updateStaffPay(member.id, patch);
          await onChanged();
          setEditingPay(false);
        }}
      />
      {shop && (
        <TeamMemberEditModal
          key={`${member.id}-${editingMember}`}
          visible={editingMember}
          shopId={shop.id}
          member={member}
          roles={roles}
          locations={locations}
          canManagePayroll={canManagePayroll}
          onClose={() => setEditingMember(false)}
          onSave={async ({ locationIds, ...input }) => {
            await updateStaffMember({ shopId: shop.id, memberId: member.id, ...input });
            // Written separately, not folded into the payload above: that goes
            // through the `update-staff` Edge Function, which has no idea this
            // column exists and would silently drop it. The direct write is
            // gated by the same staff.manage roster policy the function is.
            await setStaffLocations(member.id, locationIds);
            await onChanged();
          }}
        />
      )}
    </View>
  );
}

const tabStyles = StyleSheet.create({
  strip: { marginBottom: 14 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionButton: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  actionButtonSolid: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  actionButtonText: { color: theme.bentoInk2, fontWeight: '700', fontSize: 12.5 },
  actionButtonTextSolid: { color: theme.bentoSurface },
  actionButtonDisabled: { opacity: 0.5 },
  // White on the grey page, like the cards — bentoSoft is two points off
  // bentoPage and the field dissolved into it. Matches Inventory's.
  search: {
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 14,
    height: 44,
    paddingHorizontal: 14,
    marginBottom: 10,
    justifyContent: 'center',
  },
  searchInput: { flex: 1, height: '100%', color: theme.bentoInk },
  // Search and the filter chips share one line. Two stacked 44px bands plus
  // their margins was 110px of chrome for one job.
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  // 140px is the floor for a usable input -- below it the chips give way
  // first, since filterScroll (below) is allowed to shrink and this isn't.
  searchInRow: { flex: 1, minWidth: 140, marginBottom: 0 },
  // A row item now, not a column band, so these flags govern width, not
  // height. It has to be allowed to shrink (and to shrink past its content
  // width, via minWidth: 0) or a narrow window has nowhere to take space
  // from and the search field beside it collapses instead.
  filterScroll: { flexGrow: 0, flexShrink: 1, minWidth: 0, height: 44 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16 },
  // Zero padding and clipped: the rows run to the card's edges so a selected
  // row is a full-width band rather than a floating stripe, and the first and
  // last rows take the 26px corner.
  list: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  rowSelected: { backgroundColor: theme.bentoSoft },
  rowMain: { flex: 1, minWidth: 0 },
  rowTrailing: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 9, minWidth: 100 },
  rowName: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  rowSub: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  emptyDetail: { alignItems: 'center' },
  // The detail pane is a STACK of cards, not one card with headings -- 14px
  // apart, matching BentoGrid's own gutter.
  detailStack: { gap: 14 },
  detName: { fontSize: 19, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.5 },
  detMeta: { fontSize: 12.5, color: theme.bentoMuted },
  detHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 },
  // minWidth 0 so a long name shrinks rather than pushing the buttons off.
  detIdent: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 1, minWidth: 0 },
  detActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  histRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.bentoLine, gap: 10 },
  histTitle: { fontSize: 13, fontWeight: '600', color: theme.bentoInk },
  histMeta: { fontSize: 11, color: theme.bentoMuted, marginTop: 1 },
  histAmount: { fontSize: 13, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  histAmountNegative: { color: theme.bentoLoss },
  usualStore: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  usualStoreMeta: { fontSize: 12, color: theme.bentoMuted, marginTop: 3 },
  payrollValue: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  payrollRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  shiftRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  shiftDate: { fontSize: 12, color: theme.bentoInk2 },
  shiftDuration: { fontSize: 12, fontWeight: '700', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  permGrid: { flexDirection: 'row', gap: 8 },
  permTile: { flex: 1, alignItems: 'center', gap: 6, backgroundColor: theme.bentoSoft, borderRadius: 14, paddingVertical: 12 },
  permIcon: { width: 26, height: 26, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  permIconOn: { backgroundColor: '#E7F5ED' },
  permIconOff: { backgroundColor: theme.bentoLine },
  permIconText: { fontSize: 12 },
  permLabel: { fontSize: 10.5, fontWeight: '700', color: theme.bentoMuted },
  errorText: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10 },
});

const styles = StyleSheet.create({
  // The grey page the bento cards float on, matching Dashboard and Accounting.
  safeArea: { flex: 1, backgroundColor: theme.bentoPage },
  body: { flex: 1, padding: 18, paddingBottom: 24 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  headerTitles: { flexShrink: 1 },
  headerActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, justifyContent: 'flex-end' },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: theme.bentoMuted, marginBottom: 3 },
  title: { color: theme.bentoInk, fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  blurb: { color: theme.bentoMuted, fontSize: 13, marginTop: 3 },
  tabBar: { marginBottom: 16 },
  selfServiceContent: { flexGrow: 1, paddingBottom: 24 },
  selfServicePanel: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: 14 },
});
