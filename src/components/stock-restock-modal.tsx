import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { StoreDropdown } from '@/components/store-dropdown';
import { AppModal } from '@/components/ui/app-modal';
import { useAuth } from '@/hooks/use-auth';
import { listCategories } from '@/lib/categories';
import { extractErrorMessage } from '@/lib/checkout-errors';
import { formatCents } from '@/lib/currency';
import { describePlanError } from '@/lib/entitlements';
import { isUncosted } from '@/lib/product-costing';
import { listProducts, receiveStock } from '@/lib/products';
import { readTypedCost, readTypedQuantity, type TypedCost } from '@/lib/restock-typed-input';
import type { Product } from '@/types/models';

// Taking in a delivery, by hand or by spreadsheet.
//
// The sibling of StockTransferModal, and deliberately the same shape: a store
// picker, a search row, rows you type a quantity into, a running basket, one
// commit button, and the same two tabs. A shop that has moved stock once can
// receive a delivery without reading anything.
//
// Two differences, and both are load-bearing:
//
//  1. The picker offers the WHOLE catalogue, not just what this store holds.
//     Move can only offer what the source has, and rightly. Restock is the
//     opposite case -- the product being received is very often the one that
//     hit zero, and hiding zero-stock rows would hide exactly what arrived.
//  2. There is a unit cost column. products.cost_cents is nullable and
//     Inventory already carries a `wrong` caveat about the products missing
//     one, because they make stock-at-cost understate and gross profit
//     overstate. A delivery is the one moment the true cost is on the desk.
//
// No scanning here, on any platform. Scanning was built into the Move sheet and
// taken back out the next day: the native key capture wraps the activity's
// window, and a React Native Modal on Android is a Dialog with a window of its
// own, so keys typed while a sheet is up never reach it -- and with nothing
// swallowing it, a scanner's trailing Enter presses whichever control holds
// focus. The web-only camera button is a later job, deliberately separate.

type Tab = 'hand' | 'sheet';
// Both typed fields are held as the RAW string the person typed, never as a
// parsed number and never rewritten on the way in -- see restock-typed-input.ts
// for why that is the whole design of this screen's input handling.
type Line = { product: Product; quantity: string; cost: string };
type LineReading = { line: Line; quantity: number | null; cost: TypedCost };

export function StockRestockModal({
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
  const [chosenLocationId, setLocationId] = useState<string | null>(activeLocation?.id ?? selectable[0]?.id ?? null);
  // That initial value is computed once, at first mount, which can be before
  // the session's locations have arrived. A multi-store shop could correct it
  // with the dropdown; a one-store shop could not, because StoreDropdown
  // renders nothing for it -- so the delivery would have nowhere to land and
  // the button would sit dead with no explanation. Resolved on read rather
  // than repaired in an effect, which would be a cascading render.
  const locationId = chosenLocationId ?? activeLocation?.id ?? selectable[0]?.id ?? null;
  const [supplier, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scoped to the receiving store so each row can say what is already there --
  // "Has 3 here" is the number that decides whether 24 is right. Unlike Move,
  // rows at zero are KEPT: `listProducts` returns null for a product the store
  // does not carry, so the shop-wide list is fetched too and the two are merged.
  //
  // The merge carries `reorderLevel` alongside `stock`, not just `stock` --
  // `listProducts(shopId, locationId)` already resolves the store's own
  // override (`here.reorder_level ?? row.reorder_level`, products.ts:111),
  // and overrides are a real, settable thing (products.ts:142-149). Without
  // this a store whose own reorder level is 20 against a product default of 5
  // would read "below reorder level 5", or drop the caveat outright, on the
  // one screen where reordering is the subject.
  const load = useCallback(async () => {
    const [all, here] = await Promise.all([
      listProducts(shopId),
      locationId ? listProducts(shopId, locationId) : Promise.resolve([] as Product[]),
    ]);
    const hereByProductId = new Map(here.map((p) => [p.id, p]));
    return all.map((product) => {
      const scoped = hereByProductId.get(product.id);
      return { ...product, stock: scoped?.stock ?? 0, reorderLevel: scoped?.reorderLevel ?? product.reorderLevel };
    });
  }, [shopId, locationId]);

  // The basket is re-pointed at the reloaded rows as well as the picker.
  //
  // A line keeps a whole `Product` snapshot taken when it was added (addLine
  // below), and RowMeta reads its figures off that snapshot -- so without this
  // second setLines, changing store with a full basket would leave every basket
  // row still showing the OLD store's "Has n here" and its "below reorder
  // level n", on the one screen where those two numbers are what decide whether
  // the quantity on the invoice is the quantity to type. Only `product` is
  // replaced; the typed quantity and cost are the person's, not the server's.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    load()
      .then((rows) => {
        if (!active) return;
        setCatalogue(rows);
        const byId = new Map(rows.map((product) => [product.id, product]));
        setLines((current) =>
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
  }, [visible, load]);

  useEffect(() => {
    if (!visible) return;
    listCategories(shopId)
      .then((rows) => setCategories(rows.map((r) => r.name)))
      .catch(() => {});
  }, [visible, shopId]);

  // Closing has to put everything back, because this component is never
  // unmounted -- the screen renders it with `visible={false}` and it returns
  // null, keeping all of its state. Without this, reopening after a completed
  // delivery shows that delivery still sitting in the basket, with the button
  // stuck reading "Receiving…" because `busy` was never lowered on the success
  // path -- and the stuck flag would be the only thing stopping the same units
  // being received twice.
  const closeAndReset = useCallback(() => {
    setBusy(false);
    setLines([]);
    setNote('');
    setSupplier('');
    setReference('');
    setSearch('');
    setCategory(null);
    setError(null);
    setTab('hand');
    onClose();
  }, [onClose]);

  // Unlike Move, changing the store does NOT clear the basket: what arrived is
  // what arrived, and the quantities were read off an invoice rather than off
  // this store's availability. What changes is the per-store figures each row
  // shows -- "Has n here" and "below reorder level n" -- and the reload effect
  // above re-points the basket's rows at the new store's numbers.

  // Starts empty rather than pre-filled from `costCents`. The recorded cost is
  // shown on the row beside it, so it can be copied when it is still right --
  // but pre-filling would let a stale cost be committed as this delivery's
  // cost by pressing one button, which is the thing this column exists to fix.
  const addLine = (product: Product) => {
    setLines((current) =>
      current.some((l) => l.product.id === product.id) ? current : [...current, { product, quantity: '1', cost: '' }]
    );
  };

  // Both setters store the keystrokes and nothing else.
  //
  // Deliberately unlike the sibling's QuantityField, and unlike this file's own
  // two previous attempts. Rewriting text inside onChangeText on a controlled
  // input cannot work: the rewritten string is what the NEXT keystroke is
  // appended to, so a number is reinterpreted before it has finished being
  // typed. Dropping the row at quantity 0 was the same mistake wearing a
  // different hat -- one backspace on the seeded "1" unmounted the focused
  // input, closed the keyboard, put the product back in the results list and
  // took the unit cost already typed beside it with it, on the first edit of
  // every line. An empty field is just an empty field here; readTypedQuantity
  // returns null for it, the commit is blocked, and the footer says why.
  //
  // (The sibling's justification does not carry over: its rows start at 0 with
  // an empty field and selectTextOnFocus, it has +/- steppers, and it has no
  // second field whose contents a vanishing row would destroy.)
  const setQuantity = (productId: string, text: string) => {
    setLines((current) => current.map((l) => (l.product.id === productId ? { ...l, quantity: text } : l)));
  };

  const setCost = (productId: string, text: string) => {
    setLines((current) => current.map((l) => (l.product.id === productId ? { ...l, cost: text } : l)));
  };

  const removeLine = (productId: string) => {
    setLines((current) => current.filter((l) => l.product.id !== productId));
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
    () => lines.map((line) => ({ line, quantity: readTypedQuantity(line.quantity), cost: readTypedCost(line.cost) })),
    [lines]
  );
  const totalUnits = readings.reduce((sum, reading) => sum + (reading.quantity ?? 0), 0);
  const everyQuantityReads = readings.every((reading) => reading.quantity !== null);
  const noCostIsGibberish = readings.every((reading) => reading.cost.kind !== 'unreadable');

  // Only when there is at least one line, every one of them is priced, and
  // every quantity and price is readable.
  //
  // A part-priced delivery has no honest total, and showing the sum of the
  // priced half would be a smaller number presented as the whole thing. The
  // `readings.length > 0` guard is not redundant: `every` on an empty array is
  // true, so without it an empty basket reports a delivery worth 0.00 rather
  // than no delivery -- which is what Task 8's checkbox would then offer to
  // log as an expense. Nothing NaN can reach this sum: a cost only reads as
  // `cents` when it parsed to a finite number, and a quantity only reads as a
  // number when it is a positive whole one.
  const deliveryCents =
    readings.length > 0 && everyQuantityReads && readings.every((reading) => reading.cost.kind === 'cents')
      ? readings.reduce(
          (sum, reading) => sum + (reading.cost.kind === 'cents' ? reading.cost.cents * (reading.quantity ?? 0) : 0),
          0
        )
      : null;
  // An unreadable cost blocks the commit rather than being sent as null. null
  // means "the delivery did not say", which leaves products.cost_cents alone;
  // silently turning "12.3.4.5" into that would throw away a cost the shop
  // took the trouble to type, on the screen whose whole point is capturing it.
  const canSubmit =
    Boolean(locationId) && readings.length > 0 && everyQuantityReads && noCostIsGibberish && !busy;

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    const items: { productId: string; quantity: number; unitCostCents: number | null }[] = [];
    for (const reading of readings) {
      // canSubmit already stopped this; the loop is what proves it to the
      // types, and it runs before `busy` is raised so an impossible line
      // cannot strand the button.
      if (reading.quantity === null || reading.cost.kind === 'unreadable') return;
      items.push({
        productId: reading.line.product.id,
        quantity: reading.quantity,
        unitCostCents: reading.cost.kind === 'cents' ? reading.cost.cents : null,
      });
    }
    setBusy(true);
    setError(null);
    try {
      await receiveStock(shopId, locationId, items, {
        supplierName: supplier.trim() || null,
        reference: reference.trim() || null,
        note: note.trim() || null,
      });
      await onDone();
      closeAndReset();
    } catch (err) {
      // receive_stock is gated by enforce_shop_module('inventory'), which
      // raises the literal string "module_not_included" -- describePlanError
      // turns that (and a limit-reached error) into a sentence before the
      // generic fallback ever sees it. Same precedent as the sibling
      // (stock-transfer-modal.tsx's local extractErrorMessage).
      setError(describePlanError(err) ?? extractErrorMessage(err));
      setBusy(false);
    }
  };

  if (!visible) return null;

  const storeName = selectable.find((l) => l.id === locationId)?.name ?? '';
  const valueHint = deliveryHint(readings, deliveryCents);

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={closeAndReset}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Restock</Text>
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
            <Text style={styles.label}>RECEIVING INTO</Text>
            <StoreDropdown
              value={locationId}
              onChange={setLocationId}
              allowAll={false}
              variant="field"
              title="Receive stock into"
              placeholder="Choose a store"
            />

            {tab === 'hand' ? (
              <>
                <Text style={[styles.label, styles.labelSpaced]}>
                  SUPPLIER &amp; REFERENCE <Text style={styles.labelOptional}>— optional</Text>
                </Text>
                <View style={styles.fieldRow}>
                  <TextInput
                    value={supplier}
                    onChangeText={setSupplier}
                    placeholder="Who it came from"
                    placeholderTextColor="#999999"
                    style={[styles.input, styles.fieldHalf]}
                  />
                  <TextInput
                    value={reference}
                    onChangeText={setReference}
                    placeholder="Invoice no."
                    placeholderTextColor="#999999"
                    style={[styles.input, styles.fieldHalf]}
                  />
                </View>

                <Text style={[styles.label, styles.labelSpaced]}>ADD PRODUCTS</Text>
                {/* Deliberately NOT cleared when a product is added: clearing it
                    is what made moving fifteen items mean typing fifteen
                    searches on the Move sheet, which is why shops reached for
                    Import instead. */}
                <TextInput
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search by name, SKU or barcode"
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
                    {search.trim() ? 'Nothing here matches that.' : 'Search above to add what arrived.'}
                  </Text>
                )}

                {lines.length > 0 && (
                  <View style={styles.basket}>
                    <View style={styles.basketCap}>
                      <Text style={styles.basketCapLabel}>RECEIVING</Text>
                      <Text style={styles.basketCapTotal}>
                        {lines.length} product{lines.length === 1 ? '' : 's'} · {totalUnits} unit
                        {totalUnits === 1 ? '' : 's'}
                      </Text>
                    </View>
                    {lines.map((line) => (
                      <LineRow
                        key={line.product.id}
                        line={line}
                        onQuantity={(text) => setQuantity(line.product.id, text)}
                        onCost={(text) => setCost(line.product.id, text)}
                        onRemove={() => removeLine(line.product.id)}
                      />
                    ))}
                  </View>
                )}

                <Text style={[styles.label, styles.labelSpaced]}>NOTE</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Anything worth recording about this delivery"
                  placeholderTextColor="#999999"
                  style={styles.input}
                />
              </>
            ) : (
              <>
                <Text style={[styles.label, styles.labelSpaced]}>THE SHEET</Text>
                <Text style={styles.help}>Receiving a delivery from a sheet is coming next.</Text>
              </>
            )}

            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>

          <View style={styles.footer}>
            {tab === 'hand' ? (
              <>
                <View style={styles.footerTotal}>
                  <Text style={styles.footerTotalText}>
                    {totalUnits} unit{totalUnits === 1 ? '' : 's'} in
                  </Text>
                  <Text style={styles.footerTotalHint}>{locationId ? valueHint : 'Choose a store'}</Text>
                </View>
                <Pressable onPress={submit} disabled={!canSubmit} style={[styles.primary, !canSubmit && styles.disabled]}>
                  <Text style={styles.primaryText}>
                    {busy ? 'Receiving…' : `Receive ${totalUnits} unit${totalUnits === 1 ? '' : 's'}`}
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.footerTotal}>
                  <Text style={styles.footerTotalText}>No sheet yet</Text>
                  <Text style={styles.footerTotalHint}>{storeName ? `Receiving into ${storeName}` : 'Choose a store'}</Text>
                </View>
                <Pressable disabled style={[styles.primary, styles.disabled]}>
                  <Text style={styles.primaryText}>Receive 0 units</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </View>
    </AppModal>
  );
}

// The line under the unit count, which is also the only place a blocked commit
// is explained. Ordered by what the person has to do next: a figure when there
// is one, then the two things that hold the button down, then the one that
// merely withholds the total.
function deliveryHint(readings: LineReading[], deliveryCents: number | null): string {
  if (readings.length === 0) return 'Nothing added yet';
  if (deliveryCents !== null) return `Delivery value ${formatCents(deliveryCents)}`;
  if (readings.some((reading) => reading.quantity === null)) return 'Type how many arrived on every line';
  // Told apart from the sentence below it because they ask for different
  // things. A number too big for the column is usually a decimal point in the
  // wrong place or a pasted cell, and "that is not an amount of money" reads as
  // a lie against a field holding digits and nothing else.
  if (readings.some((reading) => reading.cost.kind === 'unreadable' && reading.cost.reason === 'too-large'))
    return 'One unit cost is larger than a cost can be — check the decimal point';
  if (readings.some((reading) => reading.cost.kind === 'unreadable'))
    return 'One unit cost is not an amount of money — fix it or clear it';
  return 'Add a unit cost to every line for a delivery value';
}

// What the receiving store already holds, and what it costs -- the two numbers
// that decide whether the quantity on the invoice is the quantity to type.
//
// "Has 0 here" is a row that stays. On the Move sheet a product the source has
// none of is nothing to offer; here it is the likeliest thing in the van.
function RowMeta({ product }: { product: Product }) {
  const low = product.reorderLevel != null && product.stock <= product.reorderLevel;
  // isUncosted, not `costCents === null` written out twice: whether a product
  // counts as missing a cost is one app-wide rule (a recorded zero is a free
  // sample, not an unanswered question), and it lives in one place.
  const recorded = isUncosted(product) ? null : product.costCents;
  return (
    <>
      <Text style={styles.lineMeta}>
        Has {product.stock} here
        {recorded !== null ? ` · cost ${formatCents(recorded)}` : ''}
        {low ? ' · ' : ''}
        {low ? <Text style={styles.lineMetaLow}>below reorder level {product.reorderLevel}</Text> : ''}
      </Text>
      {recorded === null && (
        <Text style={styles.lineMetaMissing}>
          No cost recorded — add one here and stock at cost stops understating
        </Text>
      )}
    </>
  );
}

function MatchRow({ product, onAdd }: { product: Product; onAdd: () => void }) {
  return (
    <Pressable onPress={onAdd} style={styles.lineWrap} accessibilityRole="button">
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{product.name}</Text>
          <RowMeta product={product} />
        </View>
        <Text style={styles.add}>Add</Text>
      </View>
    </Pressable>
  );
}

// Typed, not stepped: a stepper is "+1" forty times, and a delivery is bigger
// than a transfer, not smaller.
function LineRow({
  line,
  onQuantity,
  onCost,
  onRemove,
}: {
  line: Line;
  onQuantity: (text: string) => void;
  onCost: (text: string) => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.lineWrap}>
      <View style={styles.lineRow}>
        <View style={styles.lineText}>
          <Text style={styles.lineName}>{line.product.name}</Text>
          <RowMeta product={line.product} />
          <Pressable onPress={onRemove} style={styles.remove} accessibilityRole="button">
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        </View>
        <View style={styles.qtyPair}>
          <View>
            <Text style={styles.cap}>RECEIVED</Text>
            <TextInput
              // The typed text itself. Emptying it leaves an empty field and a
              // row that stays put with its unit cost intact; the footer says
              // what is missing and the commit waits.
              value={line.quantity}
              onChangeText={onQuantity}
              // Not "0": readTypedQuantity rejects a typed zero (nothing
              // arrived is not a delivery line), so a greyed 0 would be the
              // field advertising the one value that keeps the button down.
              // "1" is the seeded value, and typing it changes nothing.
              placeholder="1"
              placeholderTextColor="#999999"
              keyboardType="number-pad"
              inputMode="numeric"
              // Seeded at "1", so the usual next action is replacing it rather
              // than appending to it -- without this, tapping the field and
              // typing 24 gives 124 or 241.
              selectTextOnFocus
              aria-label={`Units of ${line.product.name} received`}
              style={styles.qtyInput}
            />
          </View>
          <View>
            <Text style={styles.cap}>UNIT COST</Text>
            <TextInput
              value={line.cost}
              onChangeText={onCost}
              placeholder={isUncosted(line.product) ? '0.00' : ((line.product.costCents ?? 0) / 100).toFixed(2)}
              placeholderTextColor="#999999"
              keyboardType="decimal-pad"
              aria-label={`Unit cost of ${line.product.name}`}
              style={[styles.qtyInput, styles.costInput]}
            />
          </View>
        </View>
      </View>
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
  fieldRow: { flexDirection: 'row', gap: 8 },
  fieldHalf: { flex: 1 },
  help: { fontSize: 13, color: '#5E5D65', marginBottom: 10, lineHeight: 19 },

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

  qtyPair: { flexDirection: 'row', gap: 8 },
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
