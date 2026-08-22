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
import { listProducts, receiveStock } from '@/lib/products';
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
type Line = { product: Product; quantity: number; cost: string };

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

  useEffect(() => {
    if (!visible) return;
    let active = true;
    load()
      .then((rows) => {
        if (active) setCatalogue(rows);
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
  // this store's availability. Only the "Has n here" figures change, and the
  // reload below refreshes those.

  // Starts empty rather than pre-filled from `costCents`. The recorded cost is
  // shown on the row beside it, so it can be copied when it is still right --
  // but pre-filling would let a stale cost be committed as this delivery's
  // cost by pressing one button, which is the thing this column exists to fix.
  const addLine = (product: Product) => {
    setLines((current) =>
      current.some((l) => l.product.id === product.id) ? current : [...current, { product, quantity: 1, cost: '' }]
    );
  };

  // Mirrors the sibling (stock-transfer-modal.tsx:177): a quantity cleared to
  // nothing removes the line, rather than leaving a row behind whose commit
  // button goes dead with nothing on screen explaining why. That is the
  // problem chosen over the alternative: a typed leading zero (e.g. the "0" of
  // "07") reads as quantity 0 too, so it drops the row before a second digit
  // can land. There is no way to tell "more digits are coming" from "the
  // field was cleared" without waiting to see what comes next, and the
  // sibling accepts the same trade for the same reason -- clearing a
  // quantity to retype it is rare next to typing it once.
  const setQuantity = (productId: string, text: string) => {
    const digits = text.replace(/[^0-9]/g, '');
    const quantity = digits === '' ? 0 : Number(digits);
    setLines((current) =>
      quantity <= 0
        ? current.filter((l) => l.product.id !== productId)
        : current.map((l) => (l.product.id === productId ? { ...l, quantity } : l))
    );
  };

  // Held as the typed STRING, not a number: a half-typed "4." parsed and
  // reformatted on every keystroke loses its trailing dot and the next digit
  // lands in the wrong column. Converted once, at submit.
  //
  // Cleaning does not guarantee a numeric result -- "." alone survives it
  // unchanged and `Number('.')` is NaN, same for "12.3.4.5" collapsing to
  // "12.3.45". That is fine: `Number.isFinite` gates `deliveryCents` below,
  // and `submit`'s JSON.stringify turns a NaN payload into `null`, so a NaN
  // cost never reaches `cost_cents`. What this function actually guards
  // against is a comma.
  //
  // iOS's decimal-pad renders the DEVICE LOCALE's separator, so on a
  // comma-decimal phone typing "1,50" for one-fifty is not a mistake, it is
  // what the keyboard offers -- and simply deleting the comma (as this used
  // to) turns it into "150", fifteen thousand cents. But a comma is also used
  // for thousands ("1,500" for fifteen hundred), and that reading has to keep
  // working too. The two are told apart by what follows the LAST comma: 1-2
  // trailing digits reads as a decimal fraction (cents), so only that comma
  // becomes a dot; 3+ trailing digits reads as a thousands grouping and is
  // dropped like any other punctuation. Any comma before the last one is
  // always a grouping separator and is dropped outright. This is re-decided
  // on every keystroke, so a number typed toward "1,500" briefly reads as a
  // decimal ("1." then "1.5" then "1.50") before the third digit flips it
  // back to a thousands grouping ("1500") -- a visible hiccup, but the two
  // finished readings this file is required to produce are correct either way.
  const setCost = (productId: string, text: string) => {
    const lastComma = text.lastIndexOf(',');
    const isDecimalComma = lastComma !== -1 && /^[0-9]{0,2}$/.test(text.slice(lastComma + 1));
    const withDot = isDecimalComma
      ? `${text.slice(0, lastComma).replace(/,/g, '')}.${text.slice(lastComma + 1)}`
      : text.replace(/,/g, '');
    const cleaned = withDot.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    setLines((current) => current.map((l) => (l.product.id === productId ? { ...l, cost: cleaned } : l)));
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

  const totalUnits = lines.reduce((sum, line) => sum + line.quantity, 0);
  // Only when there is at least one line AND every one of them is priced.
  //
  // A part-priced delivery has no honest total, and showing the sum of the
  // priced half would be a smaller number presented as the whole thing. The
  // `lines.length > 0` guard is not redundant: `every` on an empty array is
  // true, so without it an empty basket reports a delivery worth 0.00 rather
  // than no delivery -- which is what Task 8's checkbox would then offer to
  // log as an expense.
  const deliveryCents =
    lines.length > 0 && lines.every((line) => line.cost.trim() !== '')
      ? lines.reduce((sum, line) => sum + Math.round(Number(line.cost) * 100) * line.quantity, 0)
      : null;
  const canSubmit = Boolean(locationId) && lines.length > 0 && lines.every((l) => l.quantity > 0) && !busy;

  const submit = async () => {
    if (!canSubmit || !locationId) return;
    setBusy(true);
    setError(null);
    try {
      await receiveStock(
        shopId,
        locationId,
        lines.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          unitCostCents: line.cost.trim() === '' ? null : Math.round(Number(line.cost) * 100),
        })),
        { supplierName: supplier.trim() || null, reference: reference.trim() || null, note: note.trim() || null }
      );
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
  const valueHint =
    deliveryCents !== null && Number.isFinite(deliveryCents)
      ? `Delivery value ${formatCents(deliveryCents)}`
      : lines.length === 0
        ? 'Nothing added yet'
        : 'Add a unit cost to every line for a delivery value';

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

// What the receiving store already holds, and what it costs -- the two numbers
// that decide whether the quantity on the invoice is the quantity to type.
//
// "Has 0 here" is a row that stays. On the Move sheet a product the source has
// none of is nothing to offer; here it is the likeliest thing in the van.
function RowMeta({ product }: { product: Product }) {
  const low = product.reorderLevel != null && product.stock <= product.reorderLevel;
  return (
    <>
      <Text style={styles.lineMeta}>
        Has {product.stock} here
        {product.costCents !== null ? ` · cost ${formatCents(product.costCents)}` : ''}
        {low ? ' · ' : ''}
        {low ? <Text style={styles.lineMetaLow}>below reorder level {product.reorderLevel}</Text> : ''}
      </Text>
      {product.costCents === null && (
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
              // setQuantity drops a line the moment its quantity reaches 0, so
              // a row that still exists here always has quantity >= 1 --
              // there is no live 0 state left to render blank for.
              value={String(line.quantity)}
              onChangeText={onQuantity}
              placeholder="0"
              placeholderTextColor="#999999"
              keyboardType="number-pad"
              aria-label={`Units of ${line.product.name} received`}
              style={styles.qtyInput}
            />
          </View>
          <View>
            <Text style={styles.cap}>UNIT COST</Text>
            <TextInput
              value={line.cost}
              onChangeText={onCost}
              placeholder={line.product.costCents !== null ? (line.product.costCents / 100).toFixed(2) : '0.00'}
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
