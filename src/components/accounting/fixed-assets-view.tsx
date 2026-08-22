import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FixedAssetModal } from '@/components/accounting/fixed-asset-modal';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import {
  assetCategoryLabel,
  assetRegister,
  assetRegisterTotals,
  type AssetRegisterRow,
} from '@/lib/asset-depreciation';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { listFixedAssets } from '@/lib/fixed-assets';
import { scopeToLocation } from '@/lib/location-reporting';
import { toDateColumn } from '@/lib/period';
import type { FixedAsset } from '@/types/models';

const theme = Colors.light;

// The asset register: what the shop owns, what it has worn down to, and what
// is left of it.
//
// Every figure but cost is computed at read time from the asset's own columns
// (see asset-depreciation.ts). Nothing here is stored, so nothing here can be
// stale -- which is the entire reason there is no month-end routine to forget.

const EXPORT_COLUMNS: CsvColumn<AssetRegisterRow>[] = [
  { header: 'Asset', value: (r) => r.asset.name },
  { header: 'Category', value: (r) => assetCategoryLabel(r.asset.category) },
  { header: 'Acquired', value: (r) => r.asset.acquiredOn },
  { header: 'Cost', value: (r) => (r.asset.costCents / 100).toFixed(2) },
  { header: 'Life (months)', value: (r) => String(r.asset.usefulLifeMonths) },
  { header: 'Depreciation to date', value: (r) => (r.accumulatedCents / 100).toFixed(2) },
  { header: 'Book value', value: (r) => (r.bookValueCents / 100).toFixed(2) },
  { header: 'Disposed', value: (r) => r.asset.disposedOn ?? '' },
  { header: 'Proceeds', value: (r) => (r.asset.disposalProceedsCents === null ? '' : (r.asset.disposalProceedsCents / 100).toFixed(2)) },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function FixedAssetsView({
  canManage,
  locationFilter,
  revision,
  onChanged,
  setHeaderActions,
}: {
  canManage: boolean;
  locationFilter: string | null;
  revision: number;
  onChanged: () => Promise<void> | void;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [showDisposed, setShowDisposed] = useState(false);
  const [editing, setEditing] = useState<FixedAsset | 'new' | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const doubleCountNote = useCaveatDismissal('ledger-assets-double-count', 'v1');

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      setAssets(await listFixedAssets(shop.id));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop]);

  useEffect(() => {
    reload();
  }, [reload, revision]);

  // Stamped once per render pass rather than read inside the maths, so every
  // row on the screen is aged against the same instant. Two rows computed a
  // millisecond apart could otherwise straddle a month boundary.
  const asOf = useMemo(() => toDateColumn(new Date()), []);

  const scoped = useMemo(() => scopeToLocation(assets, locationFilter), [assets, locationFilter]);
  const rows = useMemo(() => assetRegister(scoped, asOf), [scoped, asOf]);
  const totals = useMemo(() => assetRegisterTotals(rows), [rows]);
  const visible = useMemo(() => rows.filter((row) => showDisposed || !row.disposed), [rows, showDisposed]);

  const columns: Column<AssetRegisterRow>[] = useMemo(
    () => [
      {
        key: 'asset',
        header: 'Asset',
        render: (row) => (
          <NameCell
            title={row.asset.name}
            meta={[
              assetCategoryLabel(row.asset.category),
              row.asset.acquiredOn,
              row.disposed ? `disposed ${row.asset.disposedOn}` : `${row.monthsRemaining} months left`,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        ),
      },
      {
        key: 'cost',
        header: 'Cost',
        numeric: true,
        width: 110,
        render: (row) => <ValueCell value={formatAccountingCents(row.asset.costCents)} />,
      },
      {
        key: 'depreciation',
        header: 'Worn down',
        numeric: true,
        width: 110,
        render: (row) => <ValueCell value={formatAccountingCents(row.accumulatedCents)} tone="muted" />,
      },
      {
        key: 'book',
        header: 'Still worth',
        numeric: true,
        width: 110,
        render: (row) =>
          row.disposed ? (
            // A disposed asset is worth nothing to the business, whatever its
            // book value was the day before. Printing that book value would
            // put an asset the shop no longer owns on the balance sheet.
            <ValueCell
              value={
                row.disposalResultCents === null || row.disposalResultCents === 0
                  ? 'gone'
                  : `${row.disposalResultCents > 0 ? '+' : ''}${formatAccountingCents(row.disposalResultCents)}`
              }
              tone={row.disposalResultCents && row.disposalResultCents < 0 ? 'danger' : 'muted'}
            />
          ) : (
            <ValueCell value={formatAccountingCents(row.bookValueCents)} strong />
          ),
      },
    ],
    []
  );

  useHeaderActions(
    setHeaderActions,
    <>
      <ExportMenu rows={visible} columns={EXPORT_COLUMNS} title="Fixed assets" filenamePrefix="fixed-assets" />
      {canManage && (
        <Pressable onPress={() => setEditing('new')} style={styles.newButton}>
          <Text style={styles.newButtonText}>+ New asset</Text>
        </Pressable>
      )}
    </>,
    [visible, canManage]
  );

  return (
    <>
      <BentoCard title="What the shop owns" scope="As of today">
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(totals.costCents)} label="At cost" hint={`${totals.liveCount} asset${totals.liveCount === 1 ? '' : 's'}`} />
          <StatTile variant="bento" value={formatCompactCents(totals.accumulatedCents)} label="Worn down so far" hint="charged to profit over time" />
          <StatTile variant="bento" value={formatCompactCents(totals.bookValueCents)} label="Still worth" hint="what the balance sheet carries" />
        </View>
      </BentoCard>

      <BentoCard
        title="Asset register"
        scope={`${visible.length} listed`}
        bodyStyle={styles.tableBody}
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {totals.disposedCount > 0 && (
          <View style={styles.filterRow}>
            <Pressable onPress={() => setShowDisposed((on) => !on)} style={[styles.chip, showDisposed && styles.chipActive]}>
              <Text style={[styles.chipText, showDisposed && styles.chipTextActive]}>
                {`Disposed (${totals.disposedCount})`}
              </Text>
            </Pressable>
          </View>
        )}

        <DataTable
          columns={columns}
          rows={visible}
          keyExtractor={(row) => row.asset.id}
          onRowPress={canManage ? (row) => setEditing(row.asset) : undefined}
          emptyLabel={
            loaded
              ? 'Nothing on the register yet. A fridge, a bike, a laptop — anything the shop bought and still owns.'
              : 'Loading…'
          }
          minWidth={660}
        />

        {totals.liveCount > 0 && !doubleCountNote.dismissed ? (
          <View style={styles.caveatWrap}>
            <Caveat tone="context" onDismiss={doubleCountNote.dismiss}>
              An asset on this register is already on the balance sheet. If you also logged it as an expense when you
              bought it, it is counted twice — assets belong here, and only the wear on them belongs in profit.
            </Caveat>
          </View>
        ) : null}
      </BentoCard>

      {editing !== null && (
        <FixedAssetModal
          key={editing === 'new' ? 'new' : editing.id}
          asset={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await reload();
            await onChanged();
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  tableBody: { paddingHorizontal: 10 },
  newButton: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newButtonText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 11 },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12, paddingHorizontal: 8 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoSoft, borderColor: theme.bentoSoft },
  chipText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoMuted },
  chipTextActive: { color: theme.bentoInk },
  caveatWrap: { paddingHorizontal: 8, marginTop: 14 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10, paddingHorizontal: 8 },
});
