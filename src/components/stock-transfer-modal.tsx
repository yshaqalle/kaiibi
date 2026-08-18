import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { QuantityField } from '@/components/quantity-field';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/categories';
import { rowsToCsv } from '@/lib/csv';
import { describePlanError } from '@/lib/entitlements';
import { shareCsv } from '@/lib/export-file';
import { downloadRejectedRowsCsv, type RejectedRow } from '@/lib/import-shared';
import { pickCsvFile } from '@/lib/pick-csv-file';
import { listProducts, setLocationStock, transferStock } from '@/lib/products';
import {
  planStockMoves,
  plannedUnits,
  STOCK_MOVE_SHEET_COLUMNS,
  STOCK_MOVE_TEMPLATE_COLUMNS,
  stockMoveSheetRows,
  type PlannedMovePair,
  type StockMovePlan,
} from '@/lib/stock-move-import';
import type { Product } from '@/types/models';

// Moving stock between stores, by hand or by spreadsheet.
//
// Without this, per-store stock is a dead end operationally: a shop that
// receives a delivery centrally has no way to distribute it, and would resort
// to editing both counts by hand -- two writes that can half-fail, leaving the
// business short with no record of what moved.
//
// Everything goes through the transfer_stock RPC, which moves both sides in one
// transaction and writes a stock_transfers record. This screen never adjusts a
// count directly, with one deliberate exception: the "the count here is wrong"
// repair below, which is a stock adjustment and says so.
//
// ## Why there are two tabs
//
// Shops were reaching for product import to redistribute stock, because it was
// the only bulk tool on Inventory -- and re-importing a catalogue to stock a
// second store INFLATES the count, since the same units get counted twice. The
// sheet tab is that job done properly. It is a tab here rather than an entry in
// the Import menu because filing it under Import is what taught people to
// expect product import to move things.
//
// Both tabs end at the same button, run the same checks, and produce the same
// transfer records. Neither moves anything before it is pressed.

type Tab = 'hand' | 'sheet';
type Line = { product: Product; quantity: number };

export function StockTransferModal({
  visible,
  shopId,
  onClose,
  onDone,
}: {
  visible: boolean;
  shopId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { locations, activeLocation } = useAuth();
  const selectable = useMemo(() => locations.filter((location) => location.active), [locations]);

  const [tab, setTab] = useState<Tab>('hand');
  const [fromId, setFromIdState] = useState<string | null>(activeLocation?.id ?? null);
  const [toId, setToId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [sourceStock, setSourceStock] = useState<Product[]>([]);
  const [destinationStock, setDestinationStock] = useState<Map<string, number>>(new Map());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState<string | null>(null);

  // Sheet tab
  const [sheetFile, setSheetFile] = useState<string | null>(null);
  const [sheetHeaders, setSheetHeaders] = useState<string[]>([]);
  const [plan, setPlan] = useState<StockMovePlan | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | null>(null);

  // Products are fetched scoped to the SOURCE store, so the counts shown are
  // what is actually available to move -- not the shop-wide rollup, which would
  // offer stock sitting at a third store.
  //
  // Returns the rows rather than setting state itself, so the effect below can
  // set state from a callback (which is what the lint rule wants) and the count
  // repair can await it in an event handler.
  const fetchSource = useCallback(
    async (): Promise<Product[]> => (fromId ? listProducts(shopId, fromId) : []),
    [shopId, fromId]
  );

  useEffect(() => {
    if (!visible) return;
    let active = true;
    fetchSource()
      .then((rows) => {
        if (active) setSourceStock(rows);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, fetchSource]);

  // The destination's counts, so a row can say what is already there. Deciding
  // how much to send without that means guessing, or leaving to look it up.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    (toId ? listProducts(shopId, toId) : Promise.resolve([] as Product[]))
      .then((rows) => {
        if (active) setDestinationStock(new Map(rows.map((p) => [p.id, p.stock])));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, shopId, toId]);

  useEffect(() => {
    if (!visible) return;
    listCategories(shopId)
      .then((rows) => setCategories(rows.map((r) => r.name)))
      .catch(() => {});
  }, [visible, shopId]);

  // Closing has to put everything back, because this component is never
  // unmounted -- the screen renders it with `visible={false}` and it returns
  // null, keeping all of its state. Without this, reopening after a completed
  // move showed that move still sitting in the basket, with the button stuck
  // reading "Moving…" because `busy` was never lowered on the success path.
  // The stuck flag was the only thing stopping the same units being moved
  // twice, which is not a safety mechanism anyone should rely on.
  const closeAndReset = useCallback(() => {
    setBusy(false);
    setLines([]);
    setNote('');
    setSearch('');
    setCategory(null);
    setError(null);
    setPlan(null);
    setSheetFile(null);
    setSheetNotice(null);
    setTab('hand');
    onClose();
  }, [onClose]);

  // Changing the source clears the basket: the quantities were chosen against
  // the old store's availability and mean nothing against the new one's. Done
  // in the handler rather than an effect on `fromId` — an effect would be a
  // cascading render, and this is simply part of what "change the source"
  // means.
  const setFromId = (locationId: string | null) => {
    setFromIdState(locationId);
    setLines([]);
    setPlan(null);
    setSheetFile(null);
    if (toId === locationId) setToId(null);
  };

  const availableOf = useCallback(
    (productId: string) => sourceStock.find((p) => p.id === productId)?.stock ?? 0,
    [sourceStock]
  );
  const atDestination = (productId: string) => destinationStock.get(productId) ?? 0;

  const setQuantity = (product: Product, quantity: number) => {
    setLines((current) => {
      if (quantity <= 0) return current.filter((l) => l.product.id !== product.id);
      if (current.some((l) => l.product.id === product.id)) {
        return current.map((l) => (l.product.id === product.id ? { ...l, quantity } : l));
      }
      return [...current, { product, quantity }];
    });
  };
  const quantityOf = (productId: string) => lines.find((l) => l.product.id === productId)?.quantity ?? 0;


  // The count is what's wrong, not the move. Writing it here rather than making
  // the shop leave for the product screen and start the move again -- stock
  // cannot go negative (`check (stock >= 0)`), so the only honest way to move
  // more than the app thinks is there is to correct what it thinks.
  const repairCount = async (product: Product, counted: number) => {
    if (!fromId) return;
    setRepairing(product.id);
    setError(null);
    try {
      await setLocationStock(product.id, fromId, counted);
      setSourceStock(await fetchSource());
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setRepairing(null);
    }
  };

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sourceStock
      .filter((p) => (category === null || p.category === category) && !lines.some((l) => l.product.id === p.id))
      .filter(
        (p) =>
          !query ||
          p.name.toLowerCase().includes(query) ||
          (p.sku ?? '').toLowerCase().includes(query) ||
          (p.barcode ?? '').toLowerCase().includes(query)
      )
      .slice(0, 12);
  }, [sourceStock, search, category, lines]);

  const overCommitted = lines.filter((line) => line.quantity > availableOf(line.product.id));
  const totalUnits = lines.reduce((sum, line) => sum + line.quantity, 0);
  const canSubmit =
    Boolean(fromId) && Boolean(toId) && fromId !== toId && lines.length > 0 && overCommitted.length === 0 && !busy;

  const submit = async () => {
    if (!canSubmit || !fromId || !toId) return;
    setBusy(true);
    setError(null);
    try {
      await transferStock(
        shopId,
        fromId,
        toId,
        lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
        note.trim() || null
      );
      await onDone();
      closeAndReset();
    } catch (err) {
      setError(extractErrorMessage(err));
      setBusy(false);
    }
  };

  // --- the sheet tab ------------------------------------------------------

  // What every store holds, keyed `productId|locationId`. Both halves of the
  // sheet need it: the download states each count, and the upload checks every
  // quantity against the store the row is leaving.
  const loadStockByLocation = useCallback(async (): Promise<Map<string, number>> => {
    const stock = new Map<string, number>();
    await Promise.all(
      selectable.map(async (location) => {
        for (const product of await listProducts(shopId, location.id)) {
          stock.set(`${product.id}|${location.id}`, product.stock);
        }
      })
    );
    return stock;
  }, [shopId, selectable]);

  // Everything the shop holds, at every store -- not just the one selected
  // above. The sheet names its own From on every row, so restricting it to the
  // current source would quietly make it a worse tool than the tab it sits in.
  //
  // Rows already in the basket come back pre-filled, so a shop that starts by
  // hand and realises it is a bigger job than it thought does not retype them.
  const downloadSheet = async () => {
    setBusy(true);
    setError(null);
    try {
      const stockByLocation = await loadStockByLocation();
      const rows = stockMoveSheetRows(await listProducts(shopId), selectable, (productId, locationId) =>
        stockByLocation.get(`${productId}|${locationId}`) ?? 0
      );
      const destination = selectable.find((l) => l.id === toId);
      const columns = STOCK_MOVE_SHEET_COLUMNS.map((column) =>
        column.header === 'To store' || column.header === 'Quantity to move'
          ? {
              header: column.header,
              value: (row: (typeof rows)[number]) => {
                // Only the row for the store the basket is moving OUT of --
                // the same product's row at another store is not what was
                // chosen, and pre-filling it would move stock twice.
                const chosen = row.location.id === fromId ? lines.find((l) => l.product.id === row.product.id) : undefined;
                if (!chosen || !destination) return '';
                return column.header === 'To store' ? destination.code || destination.name : String(chosen.quantity);
              },
            }
          : column
      );
      await shareCsv(rowsToCsv(rows, columns), 'move-stock-sheet.csv', 'Move stock sheet');
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadSheet = async () => {
    setError(null);
    setSheetNotice(null);
    const picked = await pickCsvFile(STOCK_MOVE_TEMPLATE_COLUMNS);
    if (picked.status === 'cancelled') return;
    if (picked.status === 'error') {
      setError(picked.message);
      return;
    }
    // Planned against the SHOP's products, not the source store's, because the
    // sheet names its own From on every row and may move out of several.
    const products = await listProducts(shopId);
    const stockByLocation = await loadStockByLocation();

    const next = planStockMoves(picked.parsed, {
      products,
      locations: selectable,
      stockAt: (productId, locationId) => stockByLocation.get(`${productId}|${locationId}`) ?? 0,
    });
    setSheetFile(picked.fileName);
    setSheetHeaders(picked.parsed.headers);
    setPlan(next);

    // A sheet that turns out to be one store pair is the same thing the by-hand
    // tab holds, so it lands there -- where a number can still be changed before
    // anything moves. More than one pair has no single From/To to show, so it
    // stays here as a summary.
    if (next.pairs.length === 1 && next.rejected.length === 0) {
      const pair = next.pairs[0];
      const byId = new Map(products.map((p) => [p.id, p]));
      setFromIdState(pair.fromLocationId);
      setToId(pair.toLocationId);
      setLines(pair.items.flatMap((item) => (byId.has(item.productId) ? [{ product: byId.get(item.productId)!, quantity: item.quantity }] : [])));
      if (pair.note) setNote(pair.note);
      setSheetNotice(`${picked.fileName} — ${pair.items.length} product${pair.items.length === 1 ? '' : 's'} ready. Change anything before moving.`);
      setTab('hand');
    }
  };

  // One transfer_stock call per pair. A pair that fails -- someone sold the last
  // unit between the check and the button -- fails whole and is named; the
  // others still go through, because rolling back good work for a problem the
  // shop can fix by re-uploading one section of the sheet helps nobody.
  const commitPlan = async () => {
    if (!plan || plan.pairs.length === 0) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const pair of plan.pairs) {
      try {
        await transferStock(
          shopId,
          pair.fromLocationId,
          pair.toLocationId,
          pair.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          pair.note
        );
      } catch (err) {
        failures.push(`${pair.fromName} → ${pair.toName}: ${extractErrorMessage(err)}`);
      }
    }
    await onDone();
    setBusy(false);
    if (failures.length > 0) {
      // The plan is deliberately left on screen: the pairs that DID go through
      // have already moved, so re-pressing must not repeat them. The shop reads
      // which pair failed and fixes that section of the sheet.
      setError(`Some moves did not go through.\n${failures.join('\n')}`);
      setPlan({ ...plan, pairs: [] });
      return;
    }
    closeAndReset();
  };

  const downloadRejected = async () => {
    if (!plan || plan.rejected.length === 0) return;
    await downloadRejectedRowsCsv(plan.rejected, sheetHeaders, 'move-stock-rejected.csv');
  };

  if (!visible) return null;

  const destinationName = selectable.find((l) => l.id === toId)?.name ?? '';
  const sourceName = selectable.find((l) => l.id === fromId)?.name ?? '';

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={closeAndReset}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Move stock</Text>
            <Pressable onPress={closeAndReset} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <View style={styles.segment}>
            {(['hand', 'sheet'] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => setTab(option)}
                accessibilityState={{ selected: tab === option }}
                style={[styles.segmentItem, tab === option && styles.segmentItemActive]}
              >
                <Text style={[styles.segmentText, tab === option && styles.segmentTextActive]}>
                  {option === 'hand' ? 'By hand' : 'From a sheet'}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>FROM</Text>
            <StoreDropdown
              value={fromId}
              onChange={setFromId}
              allowAll={false}
              variant="field"
              title="Move stock from"
              placeholder="Choose a store"
            />

            <Text style={[styles.label, styles.labelSpaced]}>TO</Text>
            <StoreDropdown
              value={toId}
              onChange={setToId}
              allowAll={false}
              variant="field"
              title="Move stock to"
              placeholder="Choose a store"
              unselectable={fromId ? { [fromId]: "where it's moving from" } : undefined}
            />

            {tab === 'hand' ? (
              <>
                {sheetNotice ? <Text style={styles.notice}>{sheetNotice}</Text> : null}

                {lines.length > 0 && (
                  <View style={styles.basket}>
                    <View style={styles.basketCap}>
                      <Text style={styles.basketCapLabel}>MOVING</Text>
                      <Text style={styles.basketCapTotal}>
                        {lines.length} product{lines.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
                      </Text>
                    </View>
                    {lines.map((line) => (
                      <ProductRow
                        key={line.product.id}
                        product={line.product}
                        quantity={line.quantity}
                        available={availableOf(line.product.id)}
                        atDestination={atDestination(line.product.id)}
                        sourceName={sourceName}
                        destinationName={destinationName}
                        repairing={repairing === line.product.id}
                        onChange={(quantity) => setQuantity(line.product, quantity)}
                        onRepairCount={(counted) => repairCount(line.product, counted)}
                      />
                    ))}
                  </View>
                )}

                <Text style={[styles.label, styles.labelSpaced]}>{lines.length > 0 ? 'ADD MORE' : 'ITEMS'}</Text>
                {/* Deliberately NOT cleared when a product is added: clearing it
                    is what made moving fifteen items mean typing fifteen
                    searches, which is why shops reached for Import instead.

                    No "or scan one" here, and no wedge on this sheet, though
                    scanning items as they go into the box would be the most
                    accurate way to build a move. It cannot work yet: the native
                    key capture wraps `currentActivity.window`
                    (HardwareKeyboardModule.startCapture), and a React Native
                    Modal on Android is a Dialog with a window of its own, so
                    keys typed while this sheet is up never reach it. That is
                    also why POS and Inventory stand their own scanners down
                    while any sheet is open rather than scanning through one --
                    the app has never scanned inside a modal.

                    Offering it anyway would be worse than not: with no capture
                    to swallow it, a scanner's trailing Enter presses whichever
                    control happens to hold focus, which is the same failure the
                    module's comment records as "observed opening the photo
                    picker from Inventory". Making this work means teaching the
                    module about the Dialog's window -- a native change, and one
                    to make deliberately in the code that has already cost this
                    app three keyboard bugs. */}
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search a product"
                  placeholderTextColor="#999999"
                  style={styles.input}
                />
                {categories.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.chipScroll}
                    contentContainerStyle={styles.chips}
                  >
                    <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
                    {categories.map((item) => (
                      <CategoryChip key={item} label={item} active={category === item} onPress={() => setCategory(item)} />
                    ))}
                  </ScrollView>
                )}

                {matches.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    quantity={quantityOf(product.id)}
                    available={product.stock}
                    atDestination={atDestination(product.id)}
                    sourceName={sourceName}
                    destinationName={destinationName}
                    repairing={repairing === product.id}
                    onChange={(quantity) => setQuantity(product, quantity)}
                    onRepairCount={(counted) => repairCount(product, counted)}
                  />
                ))}
                {lines.length === 0 && matches.length === 0 && (
                  <Text style={styles.empty}>
                    {search.trim() ? 'Nothing here matches that.' : 'Search above to add what you’re moving.'}
                  </Text>
                )}

                <Text style={[styles.label, styles.labelSpaced]}>NOTE</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Why this is moving, if it helps"
                  placeholderTextColor="#999999"
                  style={styles.input}
                />
              </>
            ) : (
              <SheetTab
                fileName={sheetFile}
                plan={plan}
                busy={busy}
                onDownload={downloadSheet}
                onUpload={uploadSheet}
                onDownloadRejected={downloadRejected}
              />
            )}

            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>

          <View style={styles.footer}>
            {tab === 'hand' ? (
              <>
                <View style={styles.footerTotal}>
                  <Text style={styles.footerTotalText}>
                    {lines.length} product{lines.length === 1 ? '' : 's'} · {totalUnits} unit{totalUnits === 1 ? '' : 's'}
                  </Text>
                  <Text style={styles.footerTotalHint}>
                    {fromId && toId ? `${sourceName} → ${destinationName}` : 'Choose both stores'}
                  </Text>
                </View>
                <Pressable onPress={submit} disabled={!canSubmit} style={[styles.primary, !canSubmit && styles.disabled]}>
                  <Text style={styles.primaryText}>{busy ? 'Moving…' : 'Move stock'}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.footerTotal}>
                  <Text style={styles.footerTotalText}>
                    {plan ? `${plan.pairs.reduce((n, p) => n + p.items.length, 0)} products · ${plan.pairs.reduce((n, p) => n + plannedUnits(p), 0)} units` : 'No sheet yet'}
                  </Text>
                  <Text style={styles.footerTotalHint}>
                    {plan ? `${plan.pairs.length} store pair${plan.pairs.length === 1 ? '' : 's'}` : 'Download, fill it in, upload it back'}
                  </Text>
                </View>
                <Pressable
                  onPress={commitPlan}
                  disabled={!plan || plan.pairs.length === 0 || busy}
                  style={[styles.primary, (!plan || plan.pairs.length === 0 || busy) && styles.disabled]}
                >
                  <Text style={styles.primaryText}>{busy ? 'Moving…' : 'Move stock'}</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </View>
    </AppModal>
  );
}

// One product, in either list. Says what BOTH stores hold, because how much to
// send is a decision about the pair, and the destination count was invisible.
function ProductRow({
  product,
  quantity,
  available,
  atDestination,
  sourceName,
  destinationName,
  repairing,
  onChange,
  onRepairCount,
}: {
  product: Product;
  quantity: number;
  available: number;
  atDestination: number;
  sourceName: string;
  destinationName: string;
  repairing: boolean;
  onChange: (quantity: number) => void;
  onRepairCount: (counted: number) => void;
}) {
  const over = quantity > available;

  return (
    <View style={styles.lineWrap}>
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{product.name}</Text>
          <Text style={styles.lineMeta}>
            {available} at {sourceName}
            {destinationName ? ` · ${atDestination} at ${destinationName}` : ''}
          </Text>
        </View>
        {available === 0 && quantity === 0 ? (
          <Text style={styles.noneHere}>none here</Text>
        ) : (
          <QuantityField
            quantity={quantity}
            onChange={onChange}
            max={available}
            label={`Quantity of ${product.name}`}
            fillLabel="Move all"
          />
        )}
      </View>

      {over && (
        <View style={styles.repair}>
          <Text style={styles.repairText}>
            You can&apos;t move {quantity} out of {available}. If you really have {quantity} here, the count is wrong — fix it
            and the move goes through.
          </Text>
          <View style={styles.repairActions}>
            <Pressable onPress={() => onRepairCount(quantity)} disabled={repairing} style={[styles.repairPrimary, repairing && styles.disabled]}>
              <Text style={styles.repairPrimaryText}>{repairing ? 'Saving…' : `Set the count here to ${quantity}`}</Text>
            </Pressable>
            <Pressable onPress={() => onChange(available)} style={styles.repairGhost}>
              <Text style={styles.repairGhostText}>Move {available} instead</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function SheetTab({
  fileName,
  plan,
  busy,
  onDownload,
  onUpload,
  onDownloadRejected,
}: {
  fileName: string | null;
  plan: StockMovePlan | null;
  busy: boolean;
  onDownload: () => void;
  onUpload: () => void;
  onDownloadRejected: () => void;
}) {
  return (
    <>
      <Text style={[styles.label, styles.labelSpaced]}>THE SHEET</Text>
      <Text style={styles.help}>
        Download it, fill in a <Text style={styles.helpStrong}>To store</Text> and a{' '}
        <Text style={styles.helpStrong}>Quantity to move</Text> on the rows you&apos;re moving, and upload it back. Rows you
        leave blank are ignored.
      </Text>
      <View style={styles.sheetActions}>
        <Pressable onPress={onDownload} disabled={busy} style={styles.ghost}>
          <Text style={styles.ghostText}>Download move sheet</Text>
        </Pressable>
        <Pressable onPress={onUpload} disabled={busy} style={styles.ghost}>
          <Text style={styles.ghostText}>{fileName ? 'Choose another file' : 'Upload a filled sheet'}</Text>
        </Pressable>
      </View>
      {fileName ? <Text style={styles.fileName}>{fileName}</Text> : null}

      {plan && (
        <>
          <View style={styles.pills}>
            <Pill tone="ok" text={`${plan.pairs.reduce((n, p) => n + p.items.length, 0)} moves ready`} />
            {plan.pairs.length > 0 && <Pill tone="acc" text={`${plan.pairs.length} store pair${plan.pairs.length === 1 ? '' : 's'}`} />}
            {plan.rejected.length > 0 && <Pill tone="bad" text={`${plan.rejected.length} rejected`} />}
            {plan.skipped > 0 && <Pill tone="warn" text={`${plan.skipped} blank — skipped`} />}
          </View>

          {plan.pairs.length > 0 && (
            <>
              <Text style={[styles.label, styles.labelSpaced]}>WHAT WILL MOVE</Text>
              {plan.pairs.map((pair: PlannedMovePair) => (
                <View key={`${pair.fromLocationId}->${pair.toLocationId}`} style={styles.pairRow}>
                  <Text style={styles.pairName}>
                    {pair.fromName} → {pair.toName}
                  </Text>
                  <Text style={styles.pairMeta}>
                    {pair.items.length} product{pair.items.length === 1 ? '' : 's'} · {plannedUnits(pair)} units
                  </Text>
                </View>
              ))}
            </>
          )}

          {plan.rejected.length > 0 && (
            <>
              <Text style={[styles.label, styles.labelSpaced]}>WHAT WON&apos;T</Text>
              {plan.rejected.slice(0, 8).map((row: RejectedRow) => (
                <View key={row.row} style={styles.rejectRow}>
                  <Text style={styles.rejectNumber}>Row {row.row}</Text>
                  <Text style={styles.rejectReason}>{row.reason}</Text>
                </View>
              ))}
              {plan.rejected.length > 8 && (
                <Text style={styles.empty}>…and {plan.rejected.length - 8} more, in the file below.</Text>
              )}
              <Pressable onPress={onDownloadRejected} style={styles.ghost}>
                <Text style={styles.ghostText}>Download rejected rows</Text>
              </Pressable>
            </>
          )}
        </>
      )}
    </>
  );
}

function Pill({ tone, text }: { tone: 'ok' | 'bad' | 'warn' | 'acc'; text: string }) {
  return (
    <View style={[styles.pill, styles[`pill_${tone}`]]}>
      <Text style={[styles.pillText, styles[`pillText_${tone}`]]}>{text}</Text>
    </View>
  );
}

// Supabase/PostgREST errors are plain {code, message, ...} objects, never
// `instanceof Error`. The RPC's own message is the useful one here — it names
// the product and the counts ("insufficient stock for Soap at the source
// location: has 4, need 10").
function extractErrorMessage(err: unknown): string {
  // Moving stock between branches is the multi_location module, so this is the
  // most likely place a Standard shop meets a plan wall. Without this it would
  // read as the bare string "module_not_included".
  const planError = describePlanError(err);
  if (planError) return planError;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not move this stock.';
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '88%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  segment: { flexDirection: 'row', backgroundColor: '#F2F2F2', borderRadius: 12, padding: 4, gap: 4, marginBottom: 16 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 9 },
  segmentItemActive: { backgroundColor: '#FFFFFF' },
  segmentText: { fontSize: 13, fontWeight: '700', color: '#6B6B73' },
  segmentTextActive: { color: '#111111' },
  body: { flexGrow: 0 },
  label: { color: '#999999', fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
  labelSpaced: { marginTop: 16 },
  // The same three properties pos.tsx needs on its category row, for the same
  // reason: without them Yoga sizes this container to the WHOLE chip list
  // rather than letting the row scroll, so a shop with a dozen categories
  // stretches the sheet instead of getting a sideways scroll. Five categories
  // hide it; the shops this feature was built for have many more, and the
  // category backfill hands them more still.
  chipScroll: { flexGrow: 0, flexShrink: 0, minWidth: 0 },
  chips: { flexDirection: 'row', gap: 6, paddingRight: 8, paddingTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  help: { fontSize: 13, color: '#5E5D65', marginBottom: 10, lineHeight: 19 },
  helpStrong: { fontWeight: '800', color: '#111111' },
  notice: { fontSize: 12.5, fontWeight: '700', color: '#1B47B8', backgroundColor: '#E6EDFF', borderRadius: 10, padding: 10, marginTop: 14 },

  basket: { backgroundColor: '#F6F6F7', borderRadius: 14, padding: 12, marginTop: 16 },
  basketCap: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 2 },
  basketCapLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6, color: '#6B6B73' },
  basketCapTotal: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },

  lineWrap: { borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 10 },
  lineText: { flex: 1 },
  lineName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  lineMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  noneHere: { fontSize: 11.5, fontWeight: '700', color: '#9CA3AF' },
  empty: { fontSize: 13, color: '#9CA3AF', marginTop: 12 },

  repair: { backgroundColor: '#FDF1DA', borderRadius: 12, padding: 11, marginBottom: 10 },
  repairText: { fontSize: 12.5, fontWeight: '700', color: '#8A5806', marginBottom: 8, lineHeight: 18 },
  repairActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  repairPrimary: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 8 },
  repairPrimaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  repairGhost: { borderRadius: 10, paddingHorizontal: 13, paddingVertical: 8, borderWidth: 1, borderColor: '#DCDCE4' },
  repairGhostText: { color: '#111111', fontWeight: '800', fontSize: 12 },

  sheetActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ghost: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#DCDCE4', alignSelf: 'flex-start', marginTop: 8 },
  ghostText: { color: '#111111', fontWeight: '800', fontSize: 12.5 },
  fileName: { fontSize: 12.5, color: '#5E5D65', marginTop: 10, fontWeight: '600' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  pill: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  pill_ok: { backgroundColor: '#D9EFE4' },
  pill_bad: { backgroundColor: '#FBEAEC' },
  pill_warn: { backgroundColor: '#FDF1DA' },
  pill_acc: { backgroundColor: '#E6EDFF' },
  pillText: { fontSize: 12, fontWeight: '800' },
  pillText_ok: { color: '#007A38' },
  pillText_bad: { color: '#A3202F' },
  pillText_warn: { color: '#8A5806' },
  pillText_acc: { color: '#1B47B8' },
  pairRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  pairName: { fontSize: 13, fontWeight: '800', color: '#111111', flexShrink: 1 },
  pairMeta: { fontSize: 12, color: '#9CA3AF', fontVariant: ['tabular-nums'] },
  rejectRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rejectNumber: { fontSize: 11, fontWeight: '800', color: '#A3202F', letterSpacing: 0.4 },
  rejectReason: { fontSize: 12.5, color: '#5E5D65', marginTop: 2, lineHeight: 18 },

  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#DCDCE4' },
  footerTotal: { flex: 1 },
  footerTotalText: { fontSize: 13, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  footerTotalHint: { fontSize: 11.5, fontWeight: '600', color: '#9CA3AF', marginTop: 1 },
  primary: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  primaryText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  disabled: { backgroundColor: '#CCCCCC' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 12 },
});
