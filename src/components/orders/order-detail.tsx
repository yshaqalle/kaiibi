import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Badge, type BadgeTone } from '@/components/badge';
import { AppModal } from '@/components/ui/app-modal';
import { Caveat } from '@/components/ui/caveat';
import { StatementRow } from '@/components/ui/statement-row';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { amendmentLines, summariseAmendment, type AmendLineDraft } from '@/lib/order-amendment';
import type { OrderShortfall } from '@/lib/order-fulfilment';
import type {
  OrderAmendmentLine,
  OrderAmendmentOptions,
  OrderLine,
  OrderPricing,
  OrderStatus,
  PaymentMethod,
  ShopOrder,
} from '@/lib/storefront-admin';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

// The order inbox's detail sheet: everything a shop needs to act on one
// order, and the buttons to act with -- one order opens to exactly this,
// per Task 6's property 3.
//
// Deliberately props-only, with no query and no mutation of its own.
// storefront-admin.ts owns every RPC this screen can call
// (acceptOrder/markOrderReady/cancelOrder/completeOrder); orders.tsx owns the
// async wrapping, the reload after a move lands, and the loading/error state
// that wrapping produces. This component's only local state is the two
// mid-tap forms a shop's phone needs -- a typed cancellation reason, a picked
// payment method -- neither of which has anywhere else to live.
//
// Opened from a full-width DataTable row on orders.tsx, never from inside
// another modal, so this is a plain AppModal rather than routed through
// useStagedSheet -- the iOS dropped-modal bug that hook exists for only
// bites a SECOND modal presented while a first is still up.
export type OrderDetailProps = {
  order: ShopOrder;
  items: OrderLine[];
  itemsLoading: boolean;
  itemsError: string | null;
  // Task 3's check, wired in for the first time: a shop must see what it
  // cannot currently fill before it hands the order over -- ideally before it
  // even accepts. Empty when the order is fully fillable, or when the shop
  // has already moved past a state where filling it still matters.
  shortfalls: OrderShortfall[];
  // B2: /orders is gated on `settings.access` (permissions.ts), but
  // completing an order delegates to complete_sale, which requires
  // `pos.access` (20260908000300_sale_entry_date.sql) -- a settings-only
  // manager could open this sheet and see a Complete button that always
  // failed, with a raw error naming a shop uuid. `can('pos.access')`,
  // read by orders.tsx and passed straight through: this component owns no
  // query of its own, the same posture it takes for every other permission
  // or entitlement check.
  hasPosAccess: boolean;
  onClose: () => void;
  onAccept: () => void;
  onMarkReady: () => void;
  onCancel: (reason: string) => void;
  onComplete: (method: PaymentMethod) => void;
  // Part 2. `sales.edit`, read by orders.tsx and passed through, exactly as
  // hasPosAccess is: amend_order gates on that permission
  // (20261012000000), so a member without it must not be shown a button that
  // can only fail. Its absence is EXPLAINED rather than left as a gap where
  // three buttons should be -- the same reasoning blockedOnPosAccess follows.
  canAmend: boolean;
  // Today's shelf price per productId, for the one thing the snapshot in
  // `items` cannot answer: what re-pricing this order would actually cost the
  // customer. A missing entry is not zero -- it is "unknown", and it BLOCKS
  // re-pricing rather than falling back to the agreed price, which would
  // charge one price on a line the shop believes it re-priced.
  currentPrices: Record<string, number>;
  onAmend: (lines: OrderAmendmentLine[], reason: string, options: OrderAmendmentOptions) => void;
  // True while orders.tsx has an accept/ready/cancel/complete call in
  // flight. Every action is disabled for the duration -- a second tap during
  // that window must not fire a second call.
  submitting: boolean;
  actionError: string | null;
};

// Exported so orders.tsx's own status column reads the SAME label/tone pair
// this sheet's own header badge does -- a shop must never see one word for a
// status in the list and a different one once the order is opened.
export const ORDER_STATUS_BADGE: Record<OrderStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'New', tone: 'warning' },
  accepted: { label: 'Accepted', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  completed: { label: 'Done', tone: 'default' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

const PAYMENT_METHODS: { key: PaymentMethod; label: string }[] = [
  { key: 'cash', label: 'Cash' },
  { key: 'zaad', label: 'Zaad' },
  { key: 'edahab', label: 'eDahab' },
  { key: 'other', label: 'Other' },
];

// A shortfall list keyed by productId (or, for a deleted product, there is no
// shared identity two different discontinued lines have in common -- see
// order-fulfilment.ts's own comment -- so a null-productId shortfall is never
// matched to a line by id; it is shown in its own row instead, below the
// list proper).
function shortfallFor(shortfalls: OrderShortfall[], productId: string | null): OrderShortfall | undefined {
  if (productId === null) return undefined;
  return shortfalls.find((s) => s.productId === productId);
}

// Task 6: derived from `order.status` ALONE -- `orders` stores no
// per-transition history (no accepted_at, no ready_at), so this is the
// exhaustive account of what the table can honestly say. No timestamps are
// rendered for the same reason: inventing one from `createdAt` would show
// the same instant against every step, which is worse than showing none.
//
// `cancelled` is deliberately NOT a fifth entry appended after 'completed'
// -- see StageRail below for why.
const RAIL_STEPS: { key: 'pending' | 'accepted' | 'ready' | 'completed'; label: string }[] = [
  { key: 'pending', label: 'Placed' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'ready', label: 'Ready' },
  { key: 'completed', label: 'Done' },
];

type RailStepState = 'done' | 'current' | 'upcoming' | 'cancelled';

// A word in the header badge says where an order IS; this says where it has
// BEEN and what is left, off the same four-word vocabulary
// enforce_order_transition permits (20260928000100/20260928000200).
//
// Cancelled renders as a terminal step REPLACING whatever step was next, not
// a fifth stop appended after Done -- that would claim a cancelled order was
// nearly finished. It also cannot honestly claim the order ever reached
// Accepted or Ready: `status` alone does not say which state it was
// cancelled FROM, so only 'Placed' (true of every order that exists at all)
// is shown as done before it.
function StageRail({ status }: { status: OrderStatus }) {
  if (status === 'cancelled') {
    return (
      <View style={styles.rail}>
        <RailStep label="Placed" state="done" />
        <RailStep label="Cancelled" state="cancelled" last />
      </View>
    );
  }
  const currentIndex = RAIL_STEPS.findIndex((step) => step.key === status);
  return (
    <View style={styles.rail}>
      {RAIL_STEPS.map((step, i) => (
        <RailStep
          key={step.key}
          label={step.label}
          state={i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming'}
          last={i === RAIL_STEPS.length - 1}
        />
      ))}
    </View>
  );
}

function RailStep({ label, state, last }: { label: string; state: RailStepState; last?: boolean }) {
  // The dot's fill is reinforced by the label itself (bold ink, or the word
  // "Cancelled") rather than carrying the state on colour alone -- the same
  // rule StatementRow's profit/loss colouring follows.
  const current = state === 'current' || state === 'cancelled';
  return (
    <View style={styles.railStep} accessibilityLabel={current ? `Current stage: ${label}` : undefined}>
      <View style={styles.railStepHead}>
        <View
          style={[
            styles.railDot,
            state === 'done' && styles.railDotDone,
            state === 'current' && styles.railDotCurrent,
            state === 'cancelled' && styles.railDotCancelled,
          ]}
        />
        {!last ? <View style={[styles.railBar, state === 'done' && styles.railBarDone]} /> : null}
      </View>
      <Text
        style={[
          styles.railLabel,
          (state === 'done' || state === 'current') && styles.railLabelActive,
          state === 'cancelled' && styles.railLabelCancelled,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export function OrderDetail({
  order,
  items,
  itemsLoading,
  itemsError,
  shortfalls,
  hasPosAccess,
  canAmend,
  currentPrices,
  onClose,
  onAccept,
  onMarkReady,
  onCancel,
  onComplete,
  onAmend,
  submitting,
  actionError,
}: OrderDetailProps) {
  // Which inline form, if any, is open -- mutually exclusive, and closed by
  // default so Cancel/Complete never fire on the tap that reveals them.
  const [mode, setMode] = useState<'idle' | 'cancelling' | 'completing' | 'amending'>('idle');
  const [reason, setReason] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);

  // The amend form's own state. `draft` is null until amending opens, so the
  // quantities are taken from `items` AT THAT MOMENT rather than tracked
  // against a list that is still loading when the sheet first mounts.
  const [draft, setDraft] = useState<AmendLineDraft[] | null>(null);
  const [pricing, setPricing] = useState<OrderPricing>('agreed');
  const [amendReason, setAmendReason] = useState('');
  const [customerNote, setCustomerNote] = useState('');

  const badge = ORDER_STATUS_BADGE[order.status];
  // N1: a shortfall is what the shop still cannot fill -- it stops meaning
  // that the moment the order is completed or cancelled. A just-completed
  // order shows this for the exact stock its own completion decremented, and
  // a cancelled order was never going to be filled at all. Gates both the
  // per-line rows below and the null-product rows the same way the summary
  // caveat already does.
  const orderNeedsAction = order.status !== 'completed' && order.status !== 'cancelled';
  const nullProductShortfalls = orderNeedsAction ? shortfalls.filter((s) => s.productId === null) : [];

  const canAccept = order.status === 'pending';
  const canMarkReady = order.status === 'accepted';
  // B2: folded with hasPosAccess rather than gated separately -- a member who
  // cannot ring up a sale must never see a Complete button at all, the same
  // "a button that fails is worse than no button" rule canAccept/canMarkReady
  // already follow for a status the order itself refuses.
  const canComplete = order.status === 'ready' && hasPosAccess;
  // Order is ready to hand over, but THIS member is the reason there is no
  // button for it -- distinct from canComplete being false because the order
  // itself isn't ready yet, which needs no explanation at all.
  const blockedOnPosAccess = order.status === 'ready' && !hasPosAccess;
  const canCancel = order.status === 'pending' || order.status === 'accepted' || order.status === 'ready';

  const confirmCancel = () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    onCancel(trimmed);
  };

  const confirmComplete = () => {
    if (!paymentMethod) return;
    onComplete(paymentMethod);
  };

  // ── Amending ──────────────────────────────────────────────────────────
  //
  // An amend rewrites the lines of an order that has not been settled yet.
  // A completed one has a sale posted against it and a cancelled one is
  // finished -- amend_order refuses both with `order_not_amendable`, and this
  // is that same rule read forward so no button is drawn for it.
  const canAmendNow = canAmend && orderNeedsAction;

  // Built from `items`, not from a running copy of them: the sheet's picture
  // of the order is whatever was last loaded, and an amend is always against
  // that. Quantities are seeded either at what the order says, or -- for
  // "Reduce to what I have" -- at what is actually on the shelf.
  const startAmending = (reduceToAvailable: boolean) => {
    setDraft(
      items.map((item) => {
        const short = shortfallFor(shortfalls, item.productId);
        const available = short ? short.available : item.quantity;
        return {
          productId: item.productId,
          productName: item.productName,
          agreedUnitPriceCents: item.unitPriceCents,
          currentUnitPriceCents: item.productId ? currentPrices[item.productId] ?? null : null,
          originalQuantity: item.quantity,
          quantity: reduceToAvailable ? Math.max(0, Math.min(item.quantity, available)) : item.quantity,
        };
      })
    );
    setPricing('agreed');
    setAmendReason('');
    setCustomerNote('');
    setMode('amending');
  };

  const closeAmending = () => {
    setMode('idle');
    setDraft(null);
    setAmendReason('');
    setCustomerNote('');
  };

  // Keyed by productId, NOT by productName. `products.name` carries no unique
  // constraint (0001_init.sql), so one shop can hold two products called the
  // same thing and an order can carry two identically-named lines -- and
  // matching on the name moved BOTH of them, sending a quantity the
  // shopkeeper never chose on an order the customer has already agreed to.
  // Only a line with a product is ever adjustable, so a null id cannot reach
  // this.
  const setQuantity = (productId: string, next: number) => {
    setDraft((lines) =>
      (lines ?? []).map((line) =>
        line.productId === productId ? { ...line, quantity: Math.max(0, next) } : line
      )
    );
  };

  // The whole of the sheet's arithmetic, and it is not done here --
  // order-amendment.ts owns it so the figure a shop reads before agreeing to
  // change what a customer owes is provable without rendering anything.
  const summary = useMemo(
    () =>
      summariseAmendment({
        lines: draft ?? [],
        pricing,
        deliveryFeeCents: order.deliveryFeeCents,
        previousTotalCents: order.totalCents,
      }),
    [draft, pricing, order.deliveryFeeCents, order.totalCents]
  );

  // The names that appear MORE THAN ONCE on this order. `products.name` has no
  // unique constraint, so two lines can read identically -- and two controls
  // labelled "Decrease Rice 5kg" are two a screen reader cannot tell apart.
  // Computed rather than always-on so the common case (every name distinct)
  // keeps the plain label: suffixing every row with a fragment of a uuid
  // would make the ordinary announcement worse to fix a rare collision.
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const line of draft ?? []) counts.set(line.productName, (counts.get(line.productName) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  }, [draft]);

  const amendReasonReady = amendReason.trim().length > 0;
  const canSaveAmend = amendReasonReady && summary.blocker === null && !submitting;

  const confirmAmend = () => {
    if (!draft || !canSaveAmend) return;
    const note = customerNote.trim();
    onAmend(amendmentLines(draft), amendReason.trim(), {
      pricing,
      // Omitted, not sent empty: the note is the ONLY prose a customer may
      // see, and an empty one is not a message.
      ...(note ? { customerNote: note } : {}),
    });
  };

  return (
    <AppModal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} accessibilityLabel="Close">
        {/* Stops a tap inside the sheet from closing it. */}
        <Pressable style={styles.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={styles.scrollBody}>
            <View style={styles.head}>
              <View style={styles.headText}>
                <Text style={styles.title}>Order #{order.number}</Text>
                <Badge label={badge.label} tone={badge.tone} variant="bento" />
              </View>
              <Pressable onPress={onClose} accessibilityLabel="Close" style={styles.pillButton}>
                <Text style={styles.pillButtonText}>Close</Text>
              </Pressable>
            </View>

            <StageRail status={order.status} />

            <Section label="Customer">
              <Text style={styles.value}>{order.customerName}</Text>
              <Text style={styles.valueMuted}>{order.customerPhone}</Text>
            </Section>

            <Section label="Fulfilment">
              <Text style={styles.value}>
                {order.fulfilment === 'deliver' ? `Deliver · ${order.deliveryArea ?? '—'}` : 'Collect'}
              </Text>
              {order.fulfilment === 'deliver' && order.deliveryLandmark ? (
                <Text style={styles.valueMuted}>{order.deliveryLandmark}</Text>
              ) : null}
            </Section>

            {/* Task 6: complete_storefront_order pays complete_sale the goods
                subtotal ONLY -- complete_sale would refuse the delivery fee
                as an over-payment against a total it computes from items
                alone, so the fee is posted separately to 4300 Delivery
                Income (20260928000200's own header). A $47.50 delivered
                order therefore reaches Transactions for $44.50 with nothing
                on screen to say why; this names both halves of the split.

                Gated on order.saleId, not `order.status === 'completed'`
                alone, and there is deliberately no third branch for
                "completed with no sale, treat it as pre-sale_id legacy data"
                -- that state cannot exist going forward.
                enforce_order_transition (20260928000200_complete_storefront_
                order.sql) permits `ready -> completed` ONLY in the same
                statement that attaches a non-null sale_id, so a completed
                order with saleId === null was never completed without a
                sale; its sale was DELETED after the fact. orders.sale_id is
                `on delete set null`, and delete_sale (20260908000900) --
                reachable from Accounting -> Transactions
                (transactions-tab.tsx, no storefront exemption) -- reverses
                every journal entry that sale posted and never touches
                orders.status. Naming a sale that no longer exists, or
                showing a delivery-fee line that was reversed back to zero,
                would be false on the one screen a shop reconciles from, so
                a completed-but-unsold order gets its own honest sentence
                (below) instead of a guess dressed as a fact. */}
            {order.status === 'completed' && order.saleId ? (
              <Section label="Where this order's money went">
                <View style={styles.breakdown}>
                  <StatementRow
                    label={`Goods → Sale #${order.saleId.slice(0, 6)}, in Transactions`}
                    amountCents={order.subtotalCents}
                    variant="item"
                    last={order.deliveryFeeCents === 0}
                  />
                  {/* Same rule the Goods/Delivery/Total breakdown below
                      already follows: a collect order's deliveryFeeCents is
                      always 0 (orders_delivery_matches_fulfilment,
                      20260926000050_orders.sql), and a $0.00 line here would
                      promise a fee this order never had. */}
                  {order.deliveryFeeCents > 0 ? (
                    <StatementRow label="Delivery fee → 4300 Delivery Income" amountCents={order.deliveryFeeCents} variant="item" last />
                  ) : null}
                </View>
              </Section>
            ) : null}

            {/* `context`, not `wrong`: the missing breakdown above is not an
                error to fix, it is what a deleted sale actually looks like,
                and there is no action this screen can offer a shop to bring
                a deleted sale back -- caveat.tsx's own rule for when `wrong`
                is the wrong tone. */}
            {order.status === 'completed' && !order.saleId ? (
              <Section label="Where this order's money went">
                <Caveat tone="context">
                  The sale this order became has since been deleted, so nothing here is on the books any more.
                </Caveat>
              </Section>
            ) : null}

            {order.note ? (
              <Section label="Note">
                <Text style={styles.value}>{order.note}</Text>
              </Section>
            ) : null}

            <Section label="What to collect">
              {itemsError ? (
                <Text style={styles.errorText}>{itemsError}</Text>
              ) : itemsLoading ? (
                <Text style={styles.valueMuted}>Loading…</Text>
              ) : (
                <>
                  {items.map((item) => {
                    const shortfall = orderNeedsAction ? shortfallFor(shortfalls, item.productId) : undefined;
                    return (
                      <View key={item.id} style={styles.itemRow}>
                        <View style={styles.itemNameCol}>
                          <Text style={styles.value}>{item.productName}</Text>
                          {shortfall ? (
                            <Text style={styles.shortfallText}>
                              Short by {shortfall.shortBy} — has {shortfall.available}, needs {shortfall.quantity}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.itemQty}>×{item.quantity}</Text>
                        <Text style={styles.itemPrice}>{formatCents(item.unitPriceCents)}</Text>
                        <Text style={styles.itemTotal}>{formatCents(item.lineTotalCents)}</Text>
                      </View>
                    );
                  })}
                  {nullProductShortfalls.map((s) => (
                    <View key={s.productName} style={styles.itemRow}>
                      <View style={styles.itemNameCol}>
                        <Text style={styles.value}>{s.productName}</Text>
                        <Text style={styles.shortfallText}>Short by {s.shortBy} — product no longer exists</Text>
                      </View>
                    </View>
                  ))}

                  {/* The money the customer actually agreed to at checkout
                      (checkout-form.tsx's own Goods/Delivery/Total
                      breakdown), reproduced here so a shop reads the SAME
                      figures the customer did -- not just the goods
                      subtotal a line-item list happens to sum to. Delivery
                      is shown only when there IS a fee: a collect order's
                      deliveryFeeCents is always 0 (orders_delivery_matches_
                      fulfilment, 20260926000050_orders.sql), and a $0.00
                      delivery row on a collection order would read as a
                      promise this order never made. */}
                  <View style={styles.breakdown}>
                    <StatementRow label="Goods" amountCents={order.subtotalCents} variant="item" last={order.deliveryFeeCents === 0} />
                    {order.deliveryFeeCents > 0 ? (
                      <StatementRow label="Delivery" amountCents={order.deliveryFeeCents} variant="item" last />
                    ) : null}
                    <StatementRow label="Amount to collect" amountCents={order.totalCents} variant="total" />
                  </View>
                </>
              )}
            </Section>

            {/* PART 2 TURNED THIS FROM A SENTENCE INTO A CHOICE. It used to
                read "source more stock, or cancel it below", and the only
                button under it binned the whole order -- so a customer who
                ordered five bags when there are three got nothing. The three
                moves that actually exist are now named, each saying what it
                does.

                Still not a Caveat: `wrong` needs an action or a dismiss, and
                the actions ARE the block, so wrapping them in one would put a
                tone around its own buttons. */}
            {shortfalls.length > 0 && orderNeedsAction && mode === 'idle' ? (
              <View style={styles.shortfallBlock}>
                <Text style={styles.shortfallSummary}>
                  This order cannot be filled in full right now.
                </Text>
                {canAmendNow ? (
                  <View style={styles.chipRow}>
                    <Pressable
                      onPress={() => startAmending(true)}
                      disabled={submitting}
                      accessibilityLabel="Reduce to what I have"
                      accessibilityRole="button"
                      style={[styles.primaryButton, submitting && styles.buttonDisabled]}
                    >
                      <Text style={styles.primaryButtonText}>Reduce to what I have</Text>
                    </Pressable>
                    {/* Part 4 builds split_order. Drawn so the shop can see
                        the move exists and disabled so it cannot fail: a
                        button that fails is worse than no button, and one
                        that silently does nothing is worse again. */}
                    <Pressable
                      disabled
                      accessibilityLabel="Split the order"
                      accessibilityRole="button"
                      style={[styles.secondaryButton, styles.buttonDisabled]}
                    >
                      <Text style={styles.secondaryButtonText}>Split the order</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={styles.posAccessNote}>
                    Reducing this order to what you have needs the &quot;Edit/delete sales&quot; permission, which your
                    account doesn&apos;t have. Ask an owner or manager, or cancel the order below.
                  </Text>
                )}
                {canAmendNow ? (
                  <Text style={styles.valueMuted}>
                    Splitting an order — filling part of it now and the rest later — is coming soon. For now, reduce
                    it and take the remainder as a new order.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {order.status === 'cancelled' && order.cancellationReason ? (
              <Section label="Why it was cancelled">
                <Text style={styles.value}>{order.cancellationReason}</Text>
              </Section>
            ) : null}

            {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

            {mode === 'cancelling' ? (
              <Section label="Cancellation reason">
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Why is this order being cancelled?"
                  placeholderTextColor={theme.bentoMuted}
                  multiline
                  textAlignVertical="top"
                  accessibilityLabel="Cancellation reason"
                  style={styles.input}
                />
                <View style={styles.formRow}>
                  <Pressable
                    onPress={() => {
                      setMode('idle');
                      setReason('');
                    }}
                    accessibilityLabel="Never mind"
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>Never mind</Text>
                  </Pressable>
                  <Pressable
                    onPress={confirmCancel}
                    disabled={submitting || reason.trim().length === 0}
                    accessibilityLabel="Confirm cancellation"
                    style={[styles.dangerButton, (submitting || reason.trim().length === 0) && styles.buttonDisabled]}
                  >
                    <Text style={styles.dangerButtonText}>{submitting ? 'Cancelling…' : 'Confirm cancellation'}</Text>
                  </Pressable>
                </View>
              </Section>
            ) : null}

            {mode === 'amending' && draft ? (
              <>
                <Section label="What they will get">
                  {draft.map((line, index) => {
                    const gone = line.productId === null;
                    // A deleted-product line has no id to key on and there can
                    // be more than one, so it falls back to its position.
                    // Every other line keys on the product itself -- see
                    // setQuantity for why the name will not do.
                    const key = line.productId ?? `gone-${index}`;
                    // Disambiguated ONLY when this order really does carry the
                    // name twice -- see duplicateNames above.
                    const label =
                      line.productId && duplicateNames.has(line.productName)
                        ? `${line.productName} (${line.productId.slice(0, 6)})`
                        : line.productName;
                    return (
                      <View key={key} style={styles.itemRow}>
                        <View style={styles.itemNameCol}>
                          <Text style={styles.value}>{line.productName}</Text>
                          {gone ? (
                            <Text style={styles.shortfallText}>
                              No longer in your catalogue — this line has to come off.
                            </Text>
                          ) : (
                            <Text style={styles.valueMuted}>
                              was ×{line.originalQuantity} at {formatCents(line.agreedUnitPriceCents)}
                            </Text>
                          )}
                        </View>
                        {gone ? null : (
                          <>
                            <Pressable
                              onPress={() => setQuantity(line.productId!, line.quantity - 1)}
                              disabled={submitting || line.quantity === 0}
                              accessibilityLabel={`Decrease ${label}`}
                              accessibilityRole="button"
                              style={[styles.stepper, (submitting || line.quantity === 0) && styles.buttonDisabled]}
                            >
                              <Text style={styles.stepperText}>−</Text>
                            </Pressable>
                            <Text style={styles.itemQty}>×{line.quantity}</Text>
                            <Pressable
                              onPress={() => setQuantity(line.productId!, line.quantity + 1)}
                              disabled={submitting}
                              accessibilityLabel={`Increase ${label}`}
                              accessibilityRole="button"
                              style={[styles.stepper, submitting && styles.buttonDisabled]}
                            >
                              <Text style={styles.stepperText}>+</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => setQuantity(line.productId!, 0)}
                              disabled={submitting || line.quantity === 0}
                              accessibilityLabel={`Remove ${label}`}
                              accessibilityRole="button"
                              style={[styles.pillButton, (submitting || line.quantity === 0) && styles.buttonDisabled]}
                            >
                              <Text style={styles.pillButtonText}>Remove</Text>
                            </Pressable>
                          </>
                        )}
                      </View>
                    );
                  })}
                </Section>

                {/* THE CHOICE THIS FEATURE REFUSED TO MAKE FOR THE SHOP.
                    Both modes complete -- complete_sale honours an agreed
                    price (20261011000000:640) -- so which one is right is a
                    question about what the shop owes the customer, and only
                    the shop can answer it. The default keeps the promise. */}
                <Section label="Price these at">
                  <View style={styles.chipRow}>
                    {(
                      [
                        { key: 'agreed', label: 'Keep agreed prices' },
                        { key: 'current', label: "Use today's prices" },
                      ] as { key: OrderPricing; label: string }[]
                    ).map((choice) => {
                      const active = choice.key === pricing;
                      return (
                        <Pressable
                          key={choice.key}
                          onPress={() => setPricing(choice.key)}
                          disabled={submitting}
                          accessibilityLabel={choice.label}
                          accessibilityRole="button"
                          style={[styles.chip, active && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>{choice.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {/* "what they were quoted" would be a lie on an order that
                      has ALREADY been re-priced once: re-pricing rewrites
                      order_items.unit_price_cents, so from then on the prices
                      ON the order are today's, and keeping them keeps those.
                      The wording says what is true in both cases. */}
                  <Text style={styles.valueMuted}>
                    {pricing === 'agreed'
                      ? 'The customer pays the prices already on this order — what they were quoted, unless an earlier change re-priced it.'
                      : "The customer pays your current shelf prices, which may not be what they agreed to. This cannot be undone by changing back — it rewrites the order's prices."}
                  </Text>
                </Section>

                {/* THE DELTA PANEL, and it is not decoration. An amend can
                    change what the customer owes without anyone asking them,
                    so both figures sit here, together, before it is saved --
                    the old total is what makes the new one mean anything. */}
                <Section label="What changes">
                  <View style={styles.breakdown}>
                    <StatementRow label="Was" amountCents={summary.previousTotalCents} variant="item" />
                    <StatementRow
                      label="Now"
                      amountCents={summary.nextTotalCents}
                      variant="item"
                      last={summary.differenceCents === 0}
                    />
                    {summary.differenceCents !== 0 ? (
                      <StatementRow
                        label={summary.differenceCents < 0 ? 'Customer pays less' : 'Customer pays more'}
                        amountCents={Math.abs(summary.differenceCents)}
                        variant="total"
                      />
                    ) : null}
                  </View>
                  {summary.changes.length === 0 ? (
                    <Text style={styles.valueMuted}>Nothing has changed yet.</Text>
                  ) : (
                    summary.changes.map((change, index) => (
                      <Text key={`${change.kind}-${change.productName}-${index}`} style={styles.changeLine}>
                        {change.kind === 'quantity'
                          ? `${change.productName}: ${change.from} → ${change.to}`
                          : change.kind === 'removed'
                            ? change.reason === 'product_deleted'
                              ? `${change.productName}: removed — no longer in your catalogue`
                              : `${change.productName}: removed`
                            : `${change.productName}: re-priced ${formatCents(change.fromCents)} → ${formatCents(change.toCents)}`}
                      </Text>
                    ))
                  )}
                  {summary.blocker === 'no_items' ? (
                    <Text style={styles.shortfallSummary}>
                      That would leave nothing on the order. Put something back, or cancel the order instead.
                    </Text>
                  ) : null}
                  {summary.blocker === 'price_unknown' ? (
                    <Text style={styles.shortfallSummary}>
                      Today&apos;s price for one of these lines could not be read, so this order cannot be re-priced
                      right now. Keep the agreed prices, or close this and try again.
                    </Text>
                  ) : null}
                </Section>

                {/* TWO REASONS, AND ONLY ONE OF THEM TRAVELS. The first is
                    blunt, internal and written for the shop to read weeks
                    later; the second is the only prose a customer may ever
                    see. They are separate fields, separately labelled, so the
                    honest one cannot become the forwarded one. */}
                <Section label="Why this is changing">
                  <TextInput
                    value={amendReason}
                    onChangeText={setAmendReason}
                    placeholder="Only three bags on the shelf"
                    placeholderTextColor={theme.bentoMuted}
                    multiline
                    textAlignVertical="top"
                    accessibilityLabel="Why this is changing"
                    style={styles.input}
                  />
                  <Text style={styles.valueMuted}>
                    For your records only. The customer never sees this.
                  </Text>
                </Section>

                <Section label="Message for the customer">
                  <TextInput
                    value={customerNote}
                    onChangeText={setCustomerNote}
                    placeholder="Optional — what you'd tell them on the phone"
                    placeholderTextColor={theme.bentoMuted}
                    multiline
                    textAlignVertical="top"
                    accessibilityLabel="Message for the customer"
                    style={styles.input}
                  />
                  <Text style={styles.valueMuted}>Optional, and the only part they may be shown.</Text>
                </Section>

                <View style={styles.formRow}>
                  <Pressable onPress={closeAmending} accessibilityLabel="Never mind" style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Never mind</Text>
                  </Pressable>
                  <Pressable
                    onPress={confirmAmend}
                    disabled={!canSaveAmend}
                    accessibilityLabel="Save changes"
                    accessibilityRole="button"
                    style={[styles.primaryButton, !canSaveAmend && styles.buttonDisabled]}
                  >
                    <Text style={styles.primaryButtonText}>{submitting ? 'Saving…' : 'Save changes'}</Text>
                  </Pressable>
                </View>
              </>
            ) : null}

            {mode === 'completing' ? (
              <Section label="Paid with">
                <View style={styles.chipRow}>
                  {PAYMENT_METHODS.map((method) => {
                    const active = method.key === paymentMethod;
                    return (
                      <Pressable
                        key={method.key}
                        onPress={() => setPaymentMethod(method.key)}
                        accessibilityLabel={method.label}
                        style={[styles.chip, active && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{method.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={styles.formRow}>
                  <Pressable
                    onPress={() => {
                      setMode('idle');
                      setPaymentMethod(null);
                    }}
                    accessibilityLabel="Never mind"
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>Never mind</Text>
                  </Pressable>
                  <Pressable
                    onPress={confirmComplete}
                    disabled={submitting || !paymentMethod}
                    accessibilityLabel="Confirm payment"
                    style={[styles.primaryButton, (submitting || !paymentMethod) && styles.buttonDisabled]}
                  >
                    <Text style={styles.primaryButtonText}>{submitting ? 'Completing…' : 'Confirm payment'}</Text>
                  </Pressable>
                </View>
              </Section>
            ) : null}

            {/* B2: says why there is no Complete button here, rather than
                leaving a settings-only manager to assume the app is broken --
                the same reasoning the shortfall summary above already gives
                for why there's no button to fill a shortage. */}
            {blockedOnPosAccess && mode === 'idle' ? (
              <Text style={styles.posAccessNote}>
                This order is ready to hand over, but completing it needs POS access, which your account doesn't have. Ask an owner or manager.
              </Text>
            ) : null}

            {mode === 'idle' ? (
              <View style={styles.actionsRow}>
                {canCancel ? (
                  <Pressable
                    onPress={() => setMode('cancelling')}
                    disabled={submitting}
                    accessibilityLabel="Cancel order"
                    style={[styles.secondaryButton, submitting && styles.buttonDisabled]}
                  >
                    <Text style={styles.secondaryButtonText}>Cancel order</Text>
                  </Pressable>
                ) : (
                  <View />
                )}

                {/* Not gated on a shortfall: a mistyped phone number, a
                    landmark the driver cannot find and a quantity the
                    customer changed their mind about are all amends, and none
                    of them is a stock problem. The shortfall block above is a
                    shortcut into this same form, not the only way in. */}
                {canAmendNow ? (
                  <Pressable
                    onPress={() => startAmending(false)}
                    disabled={submitting}
                    accessibilityLabel="Amend order"
                    accessibilityRole="button"
                    style={[styles.secondaryButton, submitting && styles.buttonDisabled]}
                  >
                    <Text style={styles.secondaryButtonText}>Amend order</Text>
                  </Pressable>
                ) : null}

                {canAccept ? (
                  <Pressable
                    onPress={onAccept}
                    disabled={submitting}
                    accessibilityLabel="Accept"
                    style={[styles.primaryButton, submitting && styles.buttonDisabled]}
                  >
                    <Text style={styles.primaryButtonText}>{submitting ? 'Accepting…' : 'Accept'}</Text>
                  </Pressable>
                ) : null}

                {canMarkReady ? (
                  <Pressable
                    onPress={onMarkReady}
                    disabled={submitting}
                    accessibilityLabel="Mark ready"
                    style={[styles.primaryButton, submitting && styles.buttonDisabled]}
                  >
                    <Text style={styles.primaryButtonText}>{submitting ? 'Marking ready…' : 'Mark ready'}</Text>
                  </Pressable>
                ) : null}

                {canComplete ? (
                  <Pressable
                    onPress={() => setMode('completing')}
                    disabled={submitting}
                    accessibilityLabel="Complete"
                    style={[styles.primaryButton, submitting && styles.buttonDisabled]}
                  >
                    <Text style={styles.primaryButtonText}>Complete</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </AppModal>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label.toUpperCase()}</Text>
      {children}
    </View>
  );
}

// Bento tokens throughout -- this sheet opens over orders.tsx, which is
// bento, the same posture stock-actions-sheet.tsx already takes for a sheet
// opened over a still-cream screen.
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '90%' },
  scrollBody: { padding: 18, paddingBottom: 28 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headText: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 18, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  pillButton: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  pillButtonText: { color: theme.bentoInk2, fontWeight: '700', fontSize: 12.5 },

  rail: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: theme.bentoSoft, borderRadius: 18, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12, marginBottom: 16 },
  railStep: { flex: 1, minWidth: 0 },
  railStepHead: { flexDirection: 'row', alignItems: 'center' },
  railDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.bentoSurface, borderWidth: 2, borderColor: theme.bentoLine },
  railDotDone: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  railDotCurrent: { backgroundColor: theme.bentoAccentInk, borderColor: theme.bentoAccentInk },
  railDotCancelled: { backgroundColor: theme.bentoLoss, borderColor: theme.bentoLoss },
  railBar: { flex: 1, height: 2, backgroundColor: theme.bentoLine, marginHorizontal: 4 },
  railBarDone: { backgroundColor: theme.bentoInk },
  railLabel: { fontSize: 11, fontWeight: '700', color: theme.bentoMuted, marginTop: 6 },
  railLabelActive: { color: theme.bentoInk, fontWeight: '800' },
  railLabelCancelled: { color: theme.bentoLoss, fontWeight: '800' },

  section: { marginBottom: 16 },
  sectionLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6 },
  value: { fontSize: 14, fontWeight: '700', color: theme.bentoInk },
  valueMuted: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 2 },

  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.bentoRule, gap: 8 },
  itemNameCol: { flex: 1, minWidth: 0 },
  itemQty: { width: 40, textAlign: 'right', fontSize: 12.5, color: theme.bentoMuted, fontVariant: ['tabular-nums'] },
  itemPrice: { width: 64, textAlign: 'right', fontSize: 12.5, color: theme.bentoMuted, fontVariant: ['tabular-nums'] },
  itemTotal: { width: 72, textAlign: 'right', fontSize: 13, fontWeight: '700', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  breakdown: { marginTop: 6 },
  shortfallText: { fontSize: 11.5, color: theme.bentoLoss, marginTop: 2, fontWeight: '600' },
  shortfallSummary: { fontSize: 12.5, color: theme.bentoLoss, fontWeight: '600', marginBottom: 16, lineHeight: 18 },
  shortfallBlock: { gap: 10, marginBottom: 16 },
  // Square-ish rather than the pill the Remove affordance uses: a stepper is
  // pressed repeatedly and wants a bigger, steadier target than a label.
  stepper: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: { fontSize: 16, fontWeight: '800', color: theme.bentoInk2, lineHeight: 18 },
  changeLine: { fontSize: 12.5, color: theme.bentoInk2, fontWeight: '600', marginTop: 4, lineHeight: 18 },
  posAccessNote: { fontSize: 12.5, color: theme.bentoMuted, fontWeight: '600', marginBottom: 16, lineHeight: 18 },

  errorText: { fontSize: 12.5, color: theme.bentoLoss, fontWeight: '600', marginBottom: 12 },

  input: { backgroundColor: theme.bentoSoft, borderRadius: 12, minHeight: 64, paddingHorizontal: 12, paddingVertical: 10, color: theme.bentoInk, fontSize: 13 },
  formRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  chipText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  chipTextActive: { color: '#FFFFFF' },

  actionsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 6 },
  primaryButton: { backgroundColor: theme.bentoInk, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13.5 },
  secondaryButton: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { color: theme.bentoInk2, fontWeight: '700', fontSize: 13 },
  dangerButton: { backgroundColor: theme.bentoLoss, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  dangerButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13.5 },
  buttonDisabled: { opacity: 0.45 },
});
