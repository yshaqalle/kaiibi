import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/categories';
import { extractErrorMessage } from '@/lib/checkout-errors';
import {
  COUNT_REASONS,
  reasonLabel,
  summariseCount,
  type CountSummary,
  type PlannedCountLine,
} from '@/lib/count-import';
import { formatCents } from '@/lib/currency';
import { describePlanError } from '@/lib/entitlements';
import { isUncosted } from '@/lib/product-costing';
import { listProducts, saveStockCount } from '@/lib/products';
import { readCountedQuantity } from '@/lib/restock-typed-input';
import type { Product, StockCountReason } from '@/types/models';

// A stock-take, by hand or by spreadsheet.
//
// The sibling of StockRestockModal, and deliberately the same shape: a store
// picker, a search row, rows you type a number into, a running summary, one
// commit button, the same two tabs. A shop that has received a delivery once
// can count a shelf without reading anything.
//
// Two differences, and both follow from the fact that the number typed here is
// a TOTAL rather than an amount:
//
//  1. The field is PRE-FILLED with what the app believes. Restock's quantity
//     starts empty, because zero received is the honest default. A stock-take
//     mostly confirms, so a row left untouched means "I looked, it matched" --
//     real information, and the reason the footer counts three counted while
//     only two change anything.
//  2. The VARIANCE is a column, not a footnote. The person doing the count does
//     not need to be told the 8 they just counted. What they need to see, and
//     what they will be asked about, is how far off the app was.
//
// Not built here, deliberately: scanning. The mockup does not propose it, and
// the equivalent work on the restock sheet cost a CRITICAL to get right -- a
// scan landing in a number field while the same product's row was focused read
// the barcode as the quantity. Inventory's own wedge still stands down for the
// whole time this sheet is open (inventory.tsx's `enabled`), so a scan fired
// here does nothing rather than something wrong.

type Tab = 'hand' | 'sheet';
// `counted` is the RAW string the person typed, never a parsed number and never
// rewritten on the way in. See restock-typed-input.ts for why that is the whole
// design of this screen's input handling.
type Line = { product: Product; counted: string; reason: StockCountReason | null };
type LineReading = { line: Line; counted: number | null; variance: number | null };

export function StockCountModal({ visible, shopId, onClose, onDone }: {
  visible: boolean;
  shopId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { locations, activeLocation } = useAuth();
  const selectable = useMemo(() => locations.filter((location) => location.active), [locations]);

  const [tab, setTab] = useState<Tab>('hand');
  const [chosenLocationId, setLocationId] = useState<string | null>(activeLocation?.id ?? selectable[0]?.id ?? null);
  // Resolved on read rather than repaired in an effect: the initial value is
  // computed once, at first mount, which can be before the session's locations
  // have arrived -- and a one-store shop cannot correct it, because
  // StoreDropdown renders nothing for it.
  const locationId = chosenLocationId ?? activeLocation?.id ?? selectable[0]?.id ?? null;
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  // Every basket write goes through one helper that runs its updater
  // immediately and stores the result in both the ref and the state, so a
  // handler reading the basket never reads a render behind.
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  const updateLines = useCallback((next: (current: Line[]) => Line[]) => {
    const value = next(linesRef.current);
    linesRef.current = value;
    setLines(value);
  }, []);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which line's reason chips are expanded, by product id. Inline, never a
  // second modal: a sheet opened from a sheet is dropped by iOS without a word
  // and needs useStagedSheet to survive -- five chips that unfold under the row
  // avoid the whole class, and a reason is a five-way choice, not a screen.
  const [reasonOpenFor, setReasonOpenFor] = useState<string | null>(null);
  const [logExpense, setLogExpense] = useState(false);

  // Scoped to the store being counted, because "App says 11" is the number the
  // whole screen is about. Unlike Restock, the shop-wide list is NOT merged in:
  // a stock-take walks a room, and a product this store does not carry has no
  // shelf to walk to. listProducts(shopId, locationId) already draws exactly
  // that line and keeps rows sitting at zero.
  const load = useCallback(async () => {
    if (!locationId) return [] as Product[];
    return listProducts(shopId, locationId);
  }, [shopId, locationId]);

  // The basket is re-pointed at the reloaded rows as well as the picker: a line
  // keeps a whole Product snapshot taken when it was added, and "App says" is
  // read off that snapshot. Only `product` is replaced -- the typed count and
  // the chosen reason are the person's, not the server's.
  //
  // EXCEPT when `locationId` itself has just changed. A typed `counted`
  // string is a claim about a specific shelf -- "App says 11, I found 8" --
  // and that claim does not carry to a different store just because the two
  // happen to stock a product with the same id. Re-pointing `product` alone
  // (the old behaviour) left the stale `counted` in place: change the store
  // from one holding 11 to one holding 3 and the row silently became "found
  // 11 at a shelf nobody walked", ready to overwrite the new store's real
  // count on Save. Losing the basket is the correct outcome of a store
  // change; carrying it forward is the bug.
  //
  // `lastLocationRef` is what tells an actual transition apart from this
  // effect's ordinary re-runs (first mount, a product added mid-session
  // triggering a reload) -- both of which must NOT clear a basket someone is
  // mid-typing. It starts equal to the initial `locationId`, so mount never
  // reads as a change, and it is only ever compared against the `locationId`
  // this render closed over, which is exactly the value `load` was rebuilt
  // for.
  const lastLocationRef = useRef(locationId);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const storeChanged = lastLocationRef.current !== locationId;
    lastLocationRef.current = locationId;
    if (storeChanged) {
      updateLines(() => []);
      setReasonOpenFor(null);
    }
    load()
      .then((rows) => {
        if (!active) return;
        setCatalogue(rows);
        // The basket was just emptied above -- nothing left to re-point.
        if (storeChanged) return;
        const byId = new Map(rows.map((product) => [product.id, product]));
        updateLines((current) =>
          current.map((line) => {
            const fresh = byId.get(line.product.id);
            return fresh ? { ...line, product: fresh } : line;
          })
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [visible, load, updateLines, locationId]);

  useEffect(() => {
    if (!visible) return;
    listCategories(shopId)
      .then((rows) => setCategories(rows.map((r) => r.name)))
      .catch(() => {});
  }, [visible, shopId]);

  // Closing has to put everything back, because this component is never
  // unmounted -- the screen renders it with visible={false} and it returns
  // null, keeping all of its state.
  const closeAndReset = useCallback(() => {
    setBusy(false);
    updateLines(() => []);
    setNote('');
    setSearch('');
    setCategory(null);
    setError(null);
    setReasonOpenFor(null);
    setLogExpense(false);
    setTab('hand');
    onClose();
  }, [onClose, updateLines]);

  // PRE-FILLED, and this is the difference the whole screen turns on. Restock
  // seeds "1" because a delivery is at least one unit; a count seeds what the
  // app already holds, because most lines of a stock-take confirm it. Left
  // alone, the row reads as "I looked, it matched" and still counts.
  const addLine = (product: Product) => {
    updateLines((current) =>
      current.some((l) => l.product.id === product.id)
        ? current
        : [...current, { product, counted: String(product.stock), reason: null }]
    );
  };

  // Stores the keystrokes and nothing else. Rewriting text inside onChangeText
  // on a controlled input cannot work: the rewritten string is what the NEXT
  // keystroke is appended to, so a number is reinterpreted before it has
  // finished being typed. The row is NOT dropped at zero, and not at an empty
  // field either -- one backspace unmounting the focused input would close the
  // keyboard and take the reason chosen beside it. readCountedQuantity returns
  // null for an empty field, the commit is blocked, and the footer says why.
  const setCounted = (productId: string, text: string) => {
    updateLines((current) => current.map((l) => (l.product.id === productId ? { ...l, counted: text } : l)));
  };

  // Picking the reason a line already carries clears it, so a mis-tap is
  // undoable without a sixth "None" chip pretending to be a reason.
  const setReason = (productId: string, reason: StockCountReason) => {
    updateLines((current) =>
      current.map((l) => (l.product.id === productId ? { ...l, reason: l.reason === reason ? null : reason } : l))
    );
    setReasonOpenFor(null);
  };

  const removeLine = (productId: string) => {
    updateLines((current) => current.filter((l) => l.product.id !== productId));
  };

  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalogue
      .filter((p) => (category === null || p.category === category) && !lines.some((l) => l.product.id === p.id))
      .filter(
        (p) =>
          !query ||
          p.name.toLowerCase().includes(query) ||
          (p.sku ?? '').toLowerCase().includes(query) ||
          (p.barcode ?? '').toLowerCase().includes(query)
      )
      .slice(0, 12);
  }, [catalogue, search, category, lines]);

  // Every typed field read once, here, from the whole string -- the only place
  // in this component that turns text into numbers.
  const readings: LineReading[] = useMemo(
    () =>
      lines.map((line) => {
        const counted = readCountedQuantity(line.counted);
        return { line, counted, variance: counted === null ? null : counted - line.product.stock };
      }),
    [lines]
  );
  const everyCountReads = readings.every((reading) => reading.counted !== null);

  // The plan this basket amounts to, in exactly the shape the sheet tab builds
  // -- so one summariseCount serves both tabs and the two can never disagree
  // about what "2 differ" or "$13.83 of shortfall" means.
  //
  // Empty until every field reads, because a summary computed over half a
  // basket is a smaller number presented as the whole thing. `readings.length`
  // is checked separately in `canSubmit` below and NOT relied on here: `every`
  // on an empty array is true, so an empty basket produces an empty plan and a
  // summary of zeroes -- honest for a footer, and refused by the button.
  const handLines: PlannedCountLine[] = useMemo(
    () =>
      everyCountReads
        ? readings.map((reading) => ({
            productId: reading.line.product.id,
            productName: reading.line.product.name,
            previousQuantity: reading.line.product.stock,
            countedQuantity: reading.counted!,
            variance: reading.variance!,
            reason: reading.line.reason,
            unitCostCents: isUncosted(reading.line.product) ? null : reading.line.product.costCents,
          }))
        : [],
    [readings, everyCountReads]
  );
  const handSummary = useMemo(() => summariseCount(handLines), [handLines]);

  const canSubmit = Boolean(locationId) && readings.length > 0 && everyCountReads && !busy;

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    setBusy(true);
    setError(null);
    // ONLY the write is inside the try, and the try ends the moment it
    // resolves. Everything after this point runs against a count that has
    // already committed, so nothing after it may reach a catch that leaves the
    // basket standing. On the restock sheet it did: `await onDone()` sat here,
    // onDone is the Inventory screen's reload, and a reload throwing on a
    // network blip landed in this catch -- an error beside a full basket and a
    // live Save button. Pressing it wrote the same count a second time.
    try {
      await saveStockCount(
        shopId,
        locationId,
        handLines.map((line) => ({
          productId: line.productId,
          countedQuantity: line.countedQuantity,
          reason: line.reason,
        })),
        { note: note.trim() || null }
      );
    } catch (err) {
      // save_stock_count is gated by enforce_shop_module('inventory'), which
      // raises the literal string "module_not_included" -- describePlanError
      // turns that into a sentence before the generic fallback sees it. It also
      // raises "not authorized for shop ..." for a member without
      // inventory.count, which extractErrorMessage passes through as written.
      //
      // Nothing was counted, so the basket is deliberately left exactly as it
      // is: this is the one failure a shop fixes by pressing again.
      setError(describePlanError(err) ?? extractErrorMessage(err));
      setBusy(false);
      return;
    }

    // The numbers are IN. The basket is spent from here on, and it is emptied
    // before anything that can fail.
    updateLines(() => []);
    setNote('');
    setLogExpense(false);
    // Swallowed on purpose: the caller's list refresh is not part of the
    // stock-take, and treating its failure as this screen's failure is what
    // produced the double-commit above.
    await onDone().catch(() => {});
    closeAndReset();
  };

  if (!visible) return null;

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={closeAndReset}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Count</Text>
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
                  {option === 'hand' ? 'By hand' : 'By sheet'}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>COUNTING AT</Text>
            <StoreDropdown
              value={locationId}
              onChange={setLocationId}
              allowAll={false}
              variant="field"
              title="Count stock at"
              placeholder="Choose a store"
            />

            <Text style={[styles.label, styles.labelSpaced]}>ADD PRODUCTS</Text>
            {/* Deliberately not ScanSafeField -- no scan path is offered here,
                and wrapping a field in a scan guard that can never fire is a
                component pretending to do something. */}
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search by name, SKU or barcode…"
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
                  <CategoryChip
                    key={item}
                    label={item}
                    active={category === item}
                    onPress={() => setCategory(item)}
                  />
                ))}
              </ScrollView>
            )}

            {matches.map((product) => (
              <MatchRow key={product.id} product={product} onAdd={() => addLine(product)} />
            ))}
            {lines.length === 0 && matches.length === 0 && (
              <Text style={styles.empty}>
                {search.trim() ? 'Nothing here matches that.' : 'Search above to add what you are counting.'}
              </Text>
            )}

            {lines.length > 0 && (
              <View style={styles.basket}>
                {readings.map((reading) => (
                  <LineRow
                    key={reading.line.product.id}
                    line={reading.line}
                    variance={reading.variance}
                    reasonOpen={reasonOpenFor === reading.line.product.id}
                    onToggleReason={() =>
                      setReasonOpenFor((current) =>
                        current === reading.line.product.id ? null : reading.line.product.id
                      )
                    }
                    onCounted={(text) => setCounted(reading.line.product.id, text)}
                    onReason={(reason) => setReason(reading.line.product.id, reason)}
                    onRemove={() => removeLine(reading.line.product.id)}
                  />
                ))}
              </View>
            )}

            <Text style={[styles.label, styles.labelSpaced]}>NOTE</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Anything worth recording about this stock-take"
              placeholderTextColor="#999999"
              style={styles.input}
            />

            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>

          <View style={styles.footerWrap}>
            {/* Gated on `everyCountReads` as well as a non-empty basket: with
                one line counted and one blank, `handLines` is `[]` (see the
                comment above it) and every figure here would read as zero
                sitting directly under a live per-line variance -- a
                contradiction, not an honest partial total. The empty-basket
                case (`lines.length === 0`) is still allowed through as
                zeroes, which is the honest reading of nothing counted yet. */}
            {lines.length > 0 && everyCountReads && (
              <View style={styles.basket}>
                <View style={styles.basketCap}>
                  <Text style={styles.basketCapLabel}>VARIANCE</Text>
                  <Text style={styles.basketCapTotal}>
                    {`${varianceText(handSummary.varianceUnits)} · ${varianceMoneyText(handSummary.varianceCents)}`}
                  </Text>
                </View>
                <Text style={styles.lineMeta}>
                  {`${handSummary.counted} counted · ${handSummary.matched} matched · ${handSummary.differ} differ. Nothing changes until you press Save.`}
                </Text>
              </View>
            )}
            <View style={styles.footerRow}>
              <View style={styles.footerTotal}>
                <Text style={styles.footerTotalText}>
                  {`Save ${readings.length} count${readings.length === 1 ? '' : 's'}`}
                </Text>
                <Text style={styles.footerTotalHint}>{countHint(readings, handSummary)}</Text>
              </View>
              <Pressable
                onPress={submit}
                disabled={!canSubmit}
                style={[styles.primary, !canSubmit && styles.disabled]}
                accessibilityLabel="Save counts"
              >
                <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save counts'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </AppModal>
  );
}

// The typographic minus, not a hyphen -- it is the same glyph the mockup uses
// and it lines up under tabular figures, which a hyphen does not.
function varianceText(variance: number | null): string {
  if (variance === null) return '—';
  if (variance === 0) return '0';
  return variance > 0 ? `+${variance}` : `−${Math.abs(variance)}`;
}

// `formatCents` puts the sign inside the digits -- `formatCents(-461)` is
// `$-4.61` -- which reads as a typo next to the U+2212 minus `varianceText`
// above already uses for the unit count. `formatAccountingCents`'s default
// style has the same problem with an ASCII hyphen instead (`-$4.61`), and its
// `parens` style is for a P&L, not a phone footer. The design of record
// (docs/design/inventory-count-mockup.html) reads `−$4.61`, so this takes the
// magnitude and prefixes the same minus by hand.
function varianceMoneyText(cents: number | null): string {
  if (cents === null) return 'value withheld';
  const magnitude = formatCents(Math.abs(cents));
  return cents < 0 ? `−${magnitude}` : magnitude;
}

// The line under the count, which is also the only place a blocked commit is
// explained. Ordered by what the person has to do next.
function countHint(readings: LineReading[], summary: CountSummary): string {
  if (readings.length === 0) return 'Nothing counted yet';
  if (readings.some((reading) => reading.counted === null)) return 'Type what you found on every line';
  return `${summary.differ} will change a number`;
}

function MatchRow({ product, onAdd }: { product: Product; onAdd: () => void }) {
  return (
    <Pressable
      onPress={onAdd}
      style={styles.lineWrap}
      accessibilityRole="button"
      accessibilityLabel={`Count ${product.name}`}
    >
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{product.name}</Text>
          <Text style={styles.lineMeta}>{`App says ${product.stock}`}</Text>
        </View>
        <Text style={styles.add}>Count</Text>
      </View>
    </Pressable>
  );
}

function LineRow({
  line,
  variance,
  reasonOpen,
  onToggleReason,
  onCounted,
  onReason,
  onRemove,
}: {
  line: Line;
  variance: number | null;
  reasonOpen: boolean;
  onToggleReason: () => void;
  onCounted: (text: string) => void;
  onReason: (reason: StockCountReason) => void;
  onRemove: () => void;
}) {
  const varianceStyle =
    variance === null || variance === 0
      ? styles.lineMeta
      : variance > 0
        ? styles.varianceUp
        : styles.varianceDown;
  return (
    <View style={styles.lineWrap}>
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{line.product.name}</Text>
          <Text style={styles.lineMeta}>{`App says ${line.product.stock}`}</Text>
          <Pressable onPress={onRemove} style={styles.remove} accessibilityRole="button">
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        </View>
        <View style={styles.qtyPair}>
          <View>
            <Text style={styles.cap}>COUNTED</Text>
            <TextInput
              value={line.counted}
              onChangeText={onCounted}
              keyboardType="number-pad"
              inputMode="numeric"
              selectTextOnFocus
              aria-label={`Counted units of ${line.product.name}`}
              style={styles.qtyInput}
            />
          </View>
          <Text style={[styles.varianceText, varianceStyle]}>{varianceText(variance)}</Text>
          <Pressable
            onPress={onToggleReason}
            style={styles.reasonChip}
            accessibilityRole="button"
            accessibilityLabel={`Reason for ${line.product.name}`}
          >
            <Text style={styles.reasonChipText}>{line.reason ? reasonLabel(line.reason) : 'Reason'}</Text>
          </Pressable>
        </View>
      </View>
      {reasonOpen && (
        <View style={styles.reasonRow}>
          {COUNT_REASONS.map(({ key, label }) => (
            <Pressable
              key={key}
              onPress={() => onReason(key)}
              style={styles.reasonOption}
              accessibilityRole="button"
              accessibilityLabel={`Reason: ${label}`}
            >
              <Text style={styles.reasonOptionText}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
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
  labelOptional: { fontWeight: '600', letterSpacing: 0 },
  // The same three properties pos.tsx needs on its category row, for the same
  // reason: without them Yoga sizes this container to the WHOLE chip list
  // rather than letting the row scroll, so a shop with a dozen categories
  // stretches the sheet instead of getting a sideways scroll.
  chipScroll: { flexGrow: 0, flexShrink: 0, minWidth: 0 },
  chips: { flexDirection: 'row', gap: 6, paddingRight: 8, paddingTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  // The search box and, on web, the camera button beside it. One row so the
  // button cannot drift away from the field it belongs to.
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchField: { flex: 1 },
  scanPill: { backgroundColor: '#111111', borderRadius: 10, height: 42, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  scanPillText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12.5 },
  fieldRow: { flexDirection: 'row', gap: 8 },
  fieldHalf: { flex: 1 },
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
  lineMetaLow: { color: '#8A5806', fontWeight: '700' },
  lineMetaMissing: { fontSize: 12, color: '#A3202F', fontWeight: '700', marginTop: 2, lineHeight: 17 },
  add: { fontSize: 12, fontWeight: '800', color: '#111111' },
  remove: { alignSelf: 'flex-start', marginTop: 6 },
  removeText: { fontSize: 11.5, fontWeight: '700', color: '#9CA3AF' },
  empty: { fontSize: 13, color: '#9CA3AF', marginTop: 12 },

  qtyPair: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  cap: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6, color: '#9CA3AF', marginBottom: 3 },
  qtyInput: {
    backgroundColor: '#F2F2F2',
    borderRadius: 10,
    height: 38,
    width: 62,
    paddingHorizontal: 10,
    color: '#111111',
    fontWeight: '700',
    textAlign: 'right',
  },
  costInput: { width: 78 },
  varianceText: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 30, textAlign: 'right' },
  varianceUp: { color: '#007A38' },
  varianceDown: { color: '#A3202F' },
  reasonChip: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  reasonChipText: { fontSize: 11.5, fontWeight: '700', color: '#111111' },
  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 10 },
  reasonOption: { backgroundColor: '#F2F2F2', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  reasonOptionText: { fontSize: 11.5, fontWeight: '700', color: '#111111' },

  // The sheet tab, borrowed wholesale from stock-transfer-modal.tsx so the two
  // sheets are visibly the same tool. A second set of pill colours would read
  // as a second feature.
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
  receipt: { backgroundColor: '#F6F6F7', borderRadius: 14, padding: 12, marginTop: 8 },
  receiptCap: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  receiptName: { fontSize: 13, fontWeight: '800', color: '#111111', flexShrink: 1 },
  receiptMeta: { fontSize: 12, color: '#9CA3AF', fontVariant: ['tabular-nums'] },
  receiptItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  receiptItemName: { fontSize: 12.5, color: '#5E5D65', flexShrink: 1 },
  receiptItemQty: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  costChange: { fontSize: 12.5, fontWeight: '800', color: '#111111', fontVariant: ['tabular-nums'] },
  costChangeClash: { color: '#8A5806' },
  oversized: { fontSize: 12.5, fontWeight: '700', color: '#8A5806', backgroundColor: '#FDF1DA', borderRadius: 10, padding: 10, marginTop: 8, lineHeight: 18 },
  rejectRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  rejectNumber: { fontSize: 11, fontWeight: '800', color: '#A3202F', letterSpacing: 0.4 },
  rejectReason: { fontSize: 12.5, color: '#5E5D65', marginTop: 2, lineHeight: 18 },

  footerWrap: { marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#DCDCE4', gap: 12 },
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  checkBox: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, borderColor: '#DCDCE4', alignItems: 'center', justifyContent: 'center' },
  checkBoxOn: { backgroundColor: '#111111', borderColor: '#111111' },
  checkMark: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', lineHeight: 13 },
  checkLabel: { fontSize: 12.5, fontWeight: '700', color: '#5E5D65', flexShrink: 1 },
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
