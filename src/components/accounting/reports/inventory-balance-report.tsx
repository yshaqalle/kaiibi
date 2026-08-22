import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { ExportMenu } from '@/components/export-menu';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useCaveatDismissal } from '@/hooks/use-caveat-dismissal';
import type { CsvColumn } from '@/lib/csv';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { valuationByCategory, valueInventory, type InventoryValuationRow } from '@/lib/inventory-valuation';
import { listProducts } from '@/lib/products';
import type { Product } from '@/types/models';

const theme = Colors.light;

// What the stock on the shelves is worth.
//
// Valued at COST, and the card says so in as many words, because valuing it at
// the price tag is both the intuitive thing to do and the most common way a
// small business overstates its balance sheet. The profit on stock has not been
// earned until somebody buys it.
//
// This is the same figure the balance sheet's Inventory line carries — one
// function computes both (lib/inventory-valuation.ts), so they cannot differ.

const EXPORT_COLUMNS: CsvColumn<InventoryValuationRow>[] = [
  { header: 'Product', value: (r) => r.name },
  { header: 'Category', value: (r) => r.category ?? '' },
  { header: 'Units', value: (r) => String(r.units) },
  { header: 'Unit cost', value: (r) => (r.unitCostCents === null ? '' : (r.unitCostCents / 100).toFixed(2)) },
  { header: 'Value at cost', value: (r) => (r.atCostCents / 100).toFixed(2) },
  { header: 'Unit price', value: (r) => (r.unitPriceCents / 100).toFixed(2) },
  { header: 'Value at retail', value: (r) => (r.atRetailCents / 100).toFixed(2) },
  { header: 'Costed', value: (r) => (r.uncosted ? 'no' : 'yes') },
];

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function InventoryBalanceReport({
  locationFilter,
  setHeaderActions,
}: {
  locationFilter: string | null;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uncostedNote = useCaveatDismissal(
    'reports-inventory-uncosted',
    // The signature is the CAUSE, so the caveat comes back when more stock goes
    // uncosted rather than staying dismissed over a number that has changed.
    // See the note in use-caveat-dismissal.ts.
    String(products.filter((product) => product.costCents === null && product.stock !== 0).length)
  );

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      // Scoped at the source: `listProducts` counts a store's own stock when
      // given a store, which is a different figure from filtering shop-wide
      // rows afterwards.
      setProducts(await listProducts(shop.id, locationFilter));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [shop, locationFilter]);

  useEffect(() => {
    reload();
  }, [reload]);

  const valuation = useMemo(() => valueInventory(products), [products]);
  const byCategory = useMemo(() => valuationByCategory(valuation), [valuation]);

  const columns: Column<InventoryValuationRow>[] = useMemo(
    () => [
      {
        key: 'product',
        header: 'Product',
        render: (row) => (
          <NameCell
            title={row.name}
            meta={[row.category ?? 'Uncategorised', row.uncosted ? 'no cost recorded' : null].filter(Boolean).join(' · ')}
          />
        ),
      },
      {
        key: 'units',
        header: 'Units',
        numeric: true,
        width: 80,
        render: (row) => <ValueCell value={String(row.units)} tone={row.units < 0 ? 'warning' : 'default'} />,
      },
      {
        key: 'cost',
        header: 'At cost',
        numeric: true,
        width: 120,
        render: (row) =>
          row.uncosted ? (
            // A dash, not a zero. Zero says the goods cost nothing; this says
            // nobody recorded what they cost, and only one of those is a
            // reason to go and fix something.
            <ValueCell value="—" tone="warning" />
          ) : (
            <ValueCell value={formatAccountingCents(row.atCostCents)} strong />
          ),
      },
      {
        key: 'retail',
        header: 'At retail',
        numeric: true,
        width: 120,
        render: (row) => <ValueCell value={formatAccountingCents(row.atRetailCents)} tone="muted" />,
      },
    ],
    []
  );

  useHeaderActions(
    setHeaderActions,
    <ExportMenu rows={valuation.rows} columns={EXPORT_COLUMNS} title="Inventory balance" subtitle="As of today" filenamePrefix="inventory-balance" />,
    [valuation.rows]
  );

  return (
    <>
      <BentoCard title="What the stock is worth" scope="As of today">
        <View style={styles.metricRow}>
          <StatTile variant="bento" value={formatCompactCents(valuation.totalAtCostCents)} label="At cost" hint="what the balance sheet carries" />
          <StatTile variant="bento" value={formatCompactCents(valuation.totalAtRetailCents)} label="At the price tag" hint="if every unit sold at full price" />
          <StatTile variant="bento" value={formatCompactCents(valuation.potentialMarginCents)} label="Profit still to earn" hint="not yours until it sells" />
          <StatTile variant="bento" value={String(valuation.totalUnits)} label="Units on hand" hint={`${valuation.stockedProductCount} product${valuation.stockedProductCount === 1 ? '' : 's'}`} />
        </View>

        {valuation.uncostedUnits > 0 && !uncostedNote.dismissed ? (
          // `wrong`: the cost figure IS understated, and there is something the
          // reader can do about it.
          <Caveat tone="wrong" onDismiss={uncostedNote.dismiss}>
            {`${valuation.uncostedUnits} unit${valuation.uncostedUnits === 1 ? '' : 's'} across ${valuation.uncostedProductCount} product${
              valuation.uncostedProductCount === 1 ? '' : 's'
            } have no cost recorded, so the value at cost above is understated by whatever they cost. Set a cost on them in Inventory and this figure — and the balance sheet's — corrects itself.`}
          </Caveat>
        ) : null}
      </BentoCard>

      {byCategory.length > 1 && (
        <BentoCard title="Where the money is tied up" scope="At cost">
          {byCategory.map((row) => (
            <View key={row.category} style={styles.categoryRow}>
              <View style={styles.categoryMain}>
                <Text style={styles.categoryName} numberOfLines={1}>{row.category}</Text>
                <Text style={styles.categoryMeta}>{`${row.units} units · ${row.productCount} product${row.productCount === 1 ? '' : 's'}`}</Text>
              </View>
              <Text style={styles.categoryValue}>{formatAccountingCents(row.atCostCents)}</Text>
            </View>
          ))}
        </BentoCard>
      )}

      <BentoCard title="Inventory balance summary" scope="As of today" bodyStyle={styles.tableBody}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <DataTable
          columns={columns}
          rows={valuation.rows}
          keyExtractor={(row) => row.productId}
          emptyLabel={loaded ? 'Nothing on the shelves.' : 'Loading…'}
          minWidth={660}
        />
        <Text style={styles.footnote}>
          Stock is valued at what it cost the shop, not at the price tag — the profit on it has not been earned until
          somebody buys it. Products with no units left are not listed.
        </Text>
      </BentoCard>
    </>
  );
}

const styles = StyleSheet.create({
  tableBody: { paddingHorizontal: 10 },
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  categoryMain: { flex: 1, minWidth: 0 },
  categoryName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  categoryMeta: { fontSize: 11, color: theme.bentoMuted, marginTop: 2 },
  categoryValue: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  footnote: { fontSize: 11, color: theme.bentoMuted, marginTop: 14, paddingHorizontal: 8, lineHeight: 16 },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10, paddingHorizontal: 8 },
});
