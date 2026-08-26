import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Badge, type BadgeTone } from '@/components/badge';
import { AppModal } from '@/components/ui/app-modal';
import { Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import type { OrderShortfall } from '@/lib/order-fulfilment';
import type { OrderLine, OrderStatus, PaymentMethod, ShopOrder } from '@/lib/storefront-admin';

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
  onClose: () => void;
  onAccept: () => void;
  onMarkReady: () => void;
  onCancel: (reason: string) => void;
  onComplete: (method: PaymentMethod) => void;
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

export function OrderDetail({
  order,
  items,
  itemsLoading,
  itemsError,
  shortfalls,
  onClose,
  onAccept,
  onMarkReady,
  onCancel,
  onComplete,
  submitting,
  actionError,
}: OrderDetailProps) {
  // Which inline form, if any, is open -- mutually exclusive, and closed by
  // default so Cancel/Complete never fire on the tap that reveals them.
  const [mode, setMode] = useState<'idle' | 'cancelling' | 'completing'>('idle');
  const [reason, setReason] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);

  const badge = ORDER_STATUS_BADGE[order.status];
  const nullProductShortfalls = shortfalls.filter((s) => s.productId === null);

  const canAccept = order.status === 'pending';
  const canMarkReady = order.status === 'accepted';
  const canComplete = order.status === 'ready';
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
                    const shortfall = shortfallFor(shortfalls, item.productId);
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
                </>
              )}
            </Section>

            {/* Not a Caveat: the fix on offer is only ever "cancel this order",
                so it is offered directly rather than dressed as an action on
                a Caveat this component cannot itself judge is the right one --
                a shop might still choose to source more or part-fill by hand. */}
            {shortfalls.length > 0 && order.status !== 'completed' && order.status !== 'cancelled' ? (
              <Text style={styles.shortfallSummary}>
                This order cannot be filled in full right now. Source more stock, or cancel it below.
              </Text>
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

  section: { marginBottom: 16 },
  sectionLabel: { fontSize: 10, letterSpacing: 1, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6 },
  value: { fontSize: 14, fontWeight: '700', color: theme.bentoInk },
  valueMuted: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 2 },

  itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.bentoRule, gap: 8 },
  itemNameCol: { flex: 1, minWidth: 0 },
  itemQty: { width: 40, textAlign: 'right', fontSize: 12.5, color: theme.bentoMuted, fontVariant: ['tabular-nums'] },
  itemPrice: { width: 64, textAlign: 'right', fontSize: 12.5, color: theme.bentoMuted, fontVariant: ['tabular-nums'] },
  itemTotal: { width: 72, textAlign: 'right', fontSize: 13, fontWeight: '700', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  shortfallText: { fontSize: 11.5, color: theme.bentoLoss, marginTop: 2, fontWeight: '600' },
  shortfallSummary: { fontSize: 12.5, color: theme.bentoLoss, fontWeight: '600', marginBottom: 16, lineHeight: 18 },

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
