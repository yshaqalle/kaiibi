import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LedgerAccountModal } from '@/components/accounting/ledger-account-modal';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import {
  LEDGER_ACCOUNT_TYPES,
  accountTypeLabel,
  feedBlurb,
  sortAccounts,
  subtypeLabel,
} from '@/lib/chart-of-accounts';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents } from '@/lib/currency';
import type { LedgerAccount, LedgerAccountType } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The chart of accounts: every bucket the shop's money is reported into.
//
// The column that carries the whole design is "Reports". An account either
// says what it fills itself from -- "Every till and cash drawer, at its last
// counted balance" -- or says it is hand-posted. Without it the first question
// anyone asks is why some balances can be typed and others cannot, and the
// answer is not guessable from anything else on the screen.

const EXPORT_COLUMNS: CsvColumn<LedgerAccount>[] = [
  { header: 'Code', value: (a) => a.code },
  { header: 'Name', value: (a) => a.name },
  { header: 'Type', value: (a) => accountTypeLabel(a.type) },
  { header: 'Group', value: (a) => subtypeLabel(a.subtype) },
  { header: 'Source', value: (a) => (a.feed ? 'Reported' : 'Hand-posted') },
  { header: 'Opening balance', value: (a) => (a.openingBalanceCents / 100).toFixed(2) },
  { header: 'Archived', value: (a) => (a.archived ? 'yes' : 'no') },
];

export function ChartOfAccountsView({
  accounts,
  canManage,
  onChanged,
  setHeaderActions,
}: {
  accounts: LedgerAccount[];
  canManage: boolean;
  onChanged: () => Promise<void> | void;
  setHeaderActions: HeaderActionsSetter;
}) {
  const [typeFilter, setTypeFilter] = useState<LedgerAccountType | 'all'>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<LedgerAccount | 'new' | null>(null);
  const hybridNote = useCaveatDismissal('ledger-chart-hybrid', 'v1');

  const visible = useMemo(() => {
    const rows = sortAccounts(accounts).filter((account) => showArchived || !account.archived);
    return typeFilter === 'all' ? rows : rows.filter((account) => account.type === typeFilter);
  }, [accounts, typeFilter, showArchived]);

  const archivedCount = accounts.filter((account) => account.archived).length;

  const columns: Column<LedgerAccount>[] = useMemo(
    () => [
      {
        key: 'account',
        header: 'Account',
        render: (account) => (
          <NameCell
            title={`${account.code}  ${account.name}`}
            meta={[subtypeLabel(account.subtype), account.contra ? 'deducted from its group' : null, account.archived ? 'archived' : null]
              .filter(Boolean)
              .join(' · ')}
          />
        ),
      },
      {
        key: 'source',
        header: 'Reports',
        render: (account) =>
          account.feed ? (
            <NameCell title="Reported" meta={feedBlurb(account.feed)} />
          ) : (
            <NameCell title="Hand-posted" meta="Only what the journal puts here" />
          ),
      },
      {
        key: 'opening',
        header: 'Opening',
        numeric: true,
        width: 110,
        render: (account) =>
          account.feed ? (
            // A dash, not a zero. Zero is a claim that the account started
            // empty; this account has no opening figure to have, because the
            // feed already covers what it held on day one.
            <ValueCell value="—" tone="muted" />
          ) : (
            <ValueCell
              value={account.openingBalanceCents === 0 ? '—' : formatAccountingCents(account.openingBalanceCents)}
              tone={account.openingBalanceCents === 0 ? 'muted' : 'default'}
            />
          ),
      },
    ],
    []
  );

  useHeaderActions(
    setHeaderActions,
    <>
      <ExportMenu rows={visible} columns={EXPORT_COLUMNS} title="Chart of accounts" filenamePrefix="chart-of-accounts" />
      {canManage && (
        <Pressable onPress={() => setEditing('new')} style={styles.newButton}>
          <Text style={styles.newButtonText}>+ New account</Text>
        </Pressable>
      )}
    </>,
    [visible, canManage]
  );

  return (
    <>
      <BentoCard
        title="Chart of accounts"
        scope={`${visible.length} account${visible.length === 1 ? '' : 's'}`}
        bodyStyle={styles.tableBody}
      >
        <View style={styles.filterRow}>
          <Pressable onPress={() => setTypeFilter('all')} style={[styles.chip, typeFilter === 'all' && styles.chipActive]}>
            <Text style={[styles.chipText, typeFilter === 'all' && styles.chipTextActive]}>All</Text>
          </Pressable>
          {LEDGER_ACCOUNT_TYPES.map((option) => {
            const active = option.key === typeFilter;
            return (
              <Pressable key={option.key} onPress={() => setTypeFilter(option.key)} style={[styles.chip, active && styles.chipActive]}>
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
              </Pressable>
            );
          })}
          {archivedCount > 0 && (
            <Pressable onPress={() => setShowArchived((on) => !on)} style={[styles.chip, showArchived && styles.chipActive]}>
              <Text style={[styles.chipText, showArchived && styles.chipTextActive]}>{`Archived (${archivedCount})`}</Text>
            </Pressable>
          )}
        </View>

        <DataTable
          columns={columns}
          rows={visible}
          keyExtractor={(account) => account.id}
          onRowPress={canManage ? (account) => setEditing(account) : undefined}
          emptyLabel="No accounts of this kind."
          minWidth={640}
        />

        {hybridNote.dismissed ? null : (
          <View style={styles.caveatWrap}>
            <Caveat tone="context" onDismiss={hybridNote.dismiss}>
              A reported account fills itself in from what the shop already records — you cannot type a balance into
              it, and nothing needs to be posted for it. Hand-posted accounts are the ones the journal writes to:
              capital, loans, accruals and corrections.
            </Caveat>
          </View>
        )}
      </BentoCard>

      {editing !== null && (
        <LedgerAccountModal
          key={editing === 'new' ? 'new' : editing.id}
          account={editing === 'new' ? null : editing}
          existing={accounts}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await onChanged();
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // The table has its own gutters — see the bento notes on `tableBody`.
  tableBody: { paddingHorizontal: 10 },
  newButton: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newButtonText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 11 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12, paddingHorizontal: 8 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoSoft, borderColor: theme.bentoSoft },
  chipText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoMuted },
  chipTextActive: { color: theme.bentoInk },
  caveatWrap: { paddingHorizontal: 8, marginTop: 14 },
});
