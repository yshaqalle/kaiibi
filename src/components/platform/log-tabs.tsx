import { StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import type { PlatformAuditRow, PlatformOperator, PlatformShopRow } from '@/lib/platform';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The two read-only tabs. Both are ledgers — one full-width card, one table,
// no grid. They were already rows with hairlines; the conversion makes them
// calmer and changes nothing else.

export function AuditTab({ rows, shops }: { rows: PlatformAuditRow[]; shops: PlatformShopRow[] }) {
  const storeName = (id: string | null) => shops.find((s) => s.shopId === id)?.shopName ?? (id ? id.slice(0, 8) : '—');

  const columns: Column<PlatformAuditRow>[] = [
    {
      key: 'when',
      header: 'When',
      width: 132,
      render: (row) => <ValueCell value={row.createdAt.slice(0, 16).replace('T', ' ')} tone="muted" />,
    },
    {
      key: 'action',
      header: 'Action',
      width: 168,
      render: (row) => <NameCell title={row.action} />,
    },
    {
      key: 'shop',
      header: 'Store',
      width: 176,
      render: (row) => <ValueCell value={storeName(row.targetShopId)} />,
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => (
        <Text style={styles.reason} numberOfLines={2}>
          {row.reason}
        </Text>
      ),
    },
  ];

  return (
    <View>
      <BentoCard bodyStyle={styles.tableBody}>
        <DataTable
          columns={columns}
          rows={rows}
          keyExtractor={(row) => row.id}
          emptyLabel="Nothing recorded yet."
          minWidth={760}
        />
      </BentoCard>
      <Caveat tone="context">
        Append-only. No client has an insert, update, or delete policy on this table — rows are written by the service
        role inside each action, so they can be neither forged nor scrubbed.
      </Caveat>
    </View>
  );
}

export function OperatorsTab({ operators }: { operators: PlatformOperator[] }) {
  const columns: Column<PlatformOperator>[] = [
    { key: 'role', header: 'Role', width: 132, render: (op) => <NameCell title={op.role} /> },
    { key: 'account', header: 'Account', width: 176, render: (op) => <ValueCell value={`${op.userId.slice(0, 8)}…`} /> },
    {
      key: 'status',
      header: 'Status',
      render: (op) => (
        <ValueCell
          value={`${op.active ? 'active' : 'inactive'}${op.note ? ` · ${op.note}` : ''}`}
          tone={op.active ? 'default' : 'muted'}
        />
      ),
    },
  ];

  return (
    <View>
      <BentoCard bodyStyle={styles.tableBody}>
        <DataTable
          columns={columns}
          rows={operators}
          keyExtractor={(op) => op.userId}
          emptyLabel="No operators."
          minWidth={520}
        />
      </BentoCard>
      <Caveat tone="context">
        Read-only by design. There is no &quot;add operator&quot; button anywhere in this product — appointing one is a
        deliberate SQL statement, because a privilege-granting endpoint is what turns a single compromised operator into
        a permanent foothold. Everyone here must also hold a verified second factor; without it they can read nothing at
        all.
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  // The table brings its own gutters, so the card gives up most of its 18.
  tableBody: { paddingHorizontal: 10 },
  reason: { fontSize: 12.5, color: theme.bentoMuted, lineHeight: 18 },
});
