import { useEffect, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { Colors } from '@/constants/theme';
import type { CheckoutIntent } from '@/lib/checkout-intent';
import { formatCents } from '@/lib/currency';
import { formatPoints, pointsToCents } from '@/lib/loyalty';
import type { Currency, PaymentLine, PaymentMethod } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// The phone's checkout. Customer, points and payment cannot go inline on a
// handset -- there is no room to hold a basket and a payment at once, and
// inlining them would put the money below however many items the customer
// brought -- so on compact they stay here, behind the panel's one button.
//
// Who is serving is NOT here any more: it is sticky across sales, so it is
// status rather than a per-sale decision, and it lives on the panel's foot.
export function CheckoutPanel({
  visible,
  onClose,
  cartEmpty,
  intent,
  shopId,
  selectedCustomer,
  onSelectCustomer,
  onClearCustomer,
  totalCents,
  payments,
  currencies,
  onChangePayments,
  enabledPaymentMethods,
  allowSplit,
  fullyPaid,
  submitting,
  error,
  onCheckout,
  loyaltyEnabled,
  centsPerPoint,
  pointsRedeemed,
  maxRedeemable,
  redemptionCents,
  pointsEarned,
  onChangePointsRedeemed,
  pointsMaturing,
  availableKnown,
  balanceRow,
  restChoice,
  onDismiss,
}: {
  // Whether the sheet is up. Owned by pos.tsx, because the panel's primary
  // button, the "Served by" row and a completed sale all open or close it.
  visible: boolean;
  onClose: () => void;
  cartEmpty: boolean;
  // The same sentence the sale panel puts on its own button, so the two can
  // never disagree about what completing this sale will do.
  intent: CheckoutIntent;
  shopId: string;
  selectedCustomer: SelectedCustomer | null;
  onSelectCustomer: (customer: SelectedCustomer) => void;
  onClearCustomer: () => void;
  totalCents: number;
  payments: PaymentLine[];
  currencies: Currency[];
  onChangePayments: (payments: PaymentLine[]) => void;
  enabledPaymentMethods: PaymentMethod[];
  allowSplit: boolean;
  fullyPaid: boolean;
  submitting: boolean;
  error: string | null;
  onCheckout: () => void;
  loyaltyEnabled: boolean;
  centsPerPoint: number;
  pointsRedeemed: number;
  // Already clamped by effectiveRedemption in pos.tsx against both the balance
  // and the bill -- this component never recomputes either.
  maxRedeemable: number;
  redemptionCents: number;
  pointsEarned: number;
  onChangePointsRedeemed: (points: number) => void;
  // On the balance but not yet spendable -- earned inside the shop's maturing
  // window. Shown so a cashier can answer "why can't I use all of them".
  pointsMaturing: number;
  availableKnown: boolean;
  // Handed straight through to the blocks below -- see CheckoutBlocksProps.
  balanceRow?: ReactNode;
  restChoice?: ReactNode;
  // Fired once the sheet has FINISHED dismissing (iOS only -- RN's `onDismiss`
  // is iOS-only). This is the safe moment for the caller to present a modal of
  // its own, which is what pos.tsx does with the receipt.
  onDismiss?: () => void;
}) {
  // Controlled by the caller rather than by a button of its own: the sale panel
  // owns the till's one primary action now, and two buttons that both mean
  // "check out" is exactly the confusion this screen was redesigned to end.
  const open = visible;
  const setOpen = (next: boolean) => { if (!next) onClose(); };

  // Covers both a completed sale (pos.tsx clears the cart on success) and
  // the cart being emptied manually mid-flow -- either way there's nothing
  // left to check out, so the sheet shouldn't stay open.
  useEffect(() => {
    if (cartEmpty) onClose();
  }, [cartEmpty, onClose]);

  return (
    <>

      {/* `onDismiss` fires only once the sheet's dismissal transition has
          actually finished. pos.tsx needs that signal because iOS refuses to
          present one modal while another is still mid-dismiss -- which is
          exactly the handoff a completed sale makes, from this sheet to the
          receipt. Without waiting for it the receipt is silently dropped. */}
      <AppModal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
        onDismiss={onDismiss}
      >
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>Checkout</Text>
              <Pressable onPress={() => setOpen(false)} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetScrollContent} keyboardShouldPersistTaps="handled">
              <CheckoutBlocks
                shopId={shopId}
                selectedCustomer={selectedCustomer}
                onSelectCustomer={onSelectCustomer}
                onClearCustomer={onClearCustomer}
                totalCents={totalCents}
                payments={payments}
                currencies={currencies}
                onChangePayments={onChangePayments}
                enabledPaymentMethods={enabledPaymentMethods}
                allowSplit={allowSplit}
                error={error}
                loyaltyEnabled={loyaltyEnabled}
                centsPerPoint={centsPerPoint}
                pointsRedeemed={pointsRedeemed}
                maxRedeemable={maxRedeemable}
                pointsMaturing={pointsMaturing}
                availableKnown={availableKnown}
                redemptionCents={redemptionCents}
                pointsEarned={pointsEarned}
                onChangePointsRedeemed={onChangePointsRedeemed}
                balanceRow={balanceRow}
                restChoice={restChoice}
              />
            </ScrollView>

            {/* Pinned under the scroller rather than sitting at the end of a
                long form: on a short handset the button was below the fold
                with the payment, so the last thing a cashier did was scroll
                looking for it. */}
            <View style={styles.sheetFoot}>
              <Pressable
                onPress={onCheckout}
                disabled={!intent.enabled}
                style={[styles.checkout, styles.completeSale, !intent.enabled && styles.checkoutDisabled]}
              >
                <Text style={styles.checkoutText}>{intent.label}</Text>
              </Pressable>
              {intent.hint && <Text style={styles.sheetHint}>{intent.hint}</Text>}
            </View>
          </View>
        </View>
      </AppModal>
    </>
  );
}

/**
 * Customer, points and payment -- the three decisions between a basket and a
 * completed sale. Rendered inline on the sale panel where the counter has the
 * width for it, and inside the sheet on a phone, which does not.
 *
 * Extracted so neither surface can drift from the other: there is one order of
 * blocks, and points sit between the customer and the payment on purpose --
 * spending points changes the total, which clears whatever split has been
 * entered, so they have to be spent before the money is counted.
 */
export function CustomerBlock({
  shopId,
  selectedCustomer,
  onSelectCustomer,
  onClearCustomer,
  loyaltyEnabled,
  centsPerPoint,
  pointsRedeemed,
  maxRedeemable,
  pointsMaturing,
  availableKnown,
  redemptionCents,
  pointsEarned,
  onChangePointsRedeemed,
  balanceRow,
}: CheckoutBlocksProps) {
  return (
    <>
      <CustomerPicker
        variant="row"
        shopId={shopId}
        selected={selectedCustomer}
        onSelect={onSelectCustomer}
        onClear={onClearCustomer}
        showPoints={loyaltyEnabled}
        centsPerPoint={centsPerPoint}
      />

      {/* Points sit with the customer they belong to, and before the money:
          spending them changes the total, which clears whatever split has been
          entered, so they have to be spent before the payment is counted. */}
      {loyaltyEnabled && selectedCustomer && (
        <PointsSection
          balance={selectedCustomer.pointsBalance}
          maturing={pointsMaturing}
          availableKnown={availableKnown}
          centsPerPoint={centsPerPoint}
          pointsRedeemed={pointsRedeemed}
          maxRedeemable={maxRedeemable}
          redemptionCents={redemptionCents}
          pointsEarned={pointsEarned}
          onChange={onChangePointsRedeemed}
        />
      )}

      {/* What they already owed, with the customer it belongs to rather than
          down beside the money -- it is a fact about the person, and it is the
          thing that decides whether "Pay later" is even offered. */}
      {balanceRow}
    </>
  );
}

export function PaymentBlock({
  totalCents,
  payments,
  currencies,
  onChangePayments,
  enabledPaymentMethods,
  allowSplit,
  error,
  restChoice,
}: CheckoutBlocksProps) {
  return (
    <>
      <PaymentMethodPicker
        totalCents={totalCents}
        payments={payments}
        currencies={currencies}
        onChange={onChangePayments}
        enabledMethods={enabledPaymentMethods}
        allowSplit={allowSplit}
      />

      {/* Under the methods, because it is a question about the money just
          entered rather than another way to enter it. */}
      {restChoice}

      {error && <Text style={styles.error}>{error}</Text>}
    </>
  );
}

// Both halves in the order the sheet reads them, for the surface that shows
// them together.
export function CheckoutBlocks(props: CheckoutBlocksProps) {
  return (
    <>
      <CustomerBlock {...props} />
      <PaymentBlock {...props} />
    </>
  );
}

export type CheckoutBlocksProps = {
  shopId: string;
  selectedCustomer: SelectedCustomer | null;
  onSelectCustomer: (customer: SelectedCustomer) => void;
  onClearCustomer: () => void;
  totalCents: number;
  payments: PaymentLine[];
  currencies: Currency[];
  onChangePayments: (payments: PaymentLine[]) => void;
  enabledPaymentMethods: PaymentMethod[];
  allowSplit: boolean;
  error: string | null;
  loyaltyEnabled: boolean;
  centsPerPoint: number;
  pointsRedeemed: number;
  maxRedeemable: number;
  pointsMaturing: number;
  availableKnown: boolean;
  redemptionCents: number;
  pointsEarned: number;
  onChangePointsRedeemed: (points: number) => void;
  // The two credit controls, passed in rather than built here. pos.tsx owns the
  // state behind them, and threading them through the shared props is what
  // stops the counter and the phone rendering them in two different places.
  // Both are absent on a shop that has never given credit.
  balanceRow?: ReactNode;
  restChoice?: ReactNode;
};

// Rendered only when loyalty is on AND a customer is attached, so there is
// never a disabled points control on screen needing an explanation.
function PointsSection({
  balance,
  maturing,
  availableKnown,
  centsPerPoint,
  pointsRedeemed,
  maxRedeemable,
  redemptionCents,
  pointsEarned,
  onChange,
}: {
  balance: number;
  maturing: number;
  availableKnown: boolean;
  centsPerPoint: number;
  pointsRedeemed: number;
  maxRedeemable: number;
  redemptionCents: number;
  pointsEarned: number;
  onChange: (points: number) => void;
}) {
  // Fully controlled off the session value rather than a local draft kept in
  // step by an effect: clearing the customer or completing the sale zeroes the
  // redemption upstream, and a mirrored draft would have to chase that. There
  // is nothing here for the two to disagree about.
  const draft = pointsRedeemed > 0 ? String(pointsRedeemed) : '';

  const commit = (text: string) => {
    onChange(Number(text.replace(/[^0-9]/g, '')) || 0);
  };

  // Derived from the already-clamped cents rather than recomputed, so this can
  // never disagree with the total the customer is being charged.
  const effectivePoints = centsPerPoint > 0 ? Math.round(redemptionCents / centsPerPoint) : 0;
  const spendable = Math.max(balance - maturing, 0);
  const overEntered = Number(draft) > effectivePoints;

  return (
    <View style={styles.pointsSection}>
      <Text style={styles.pointsLabel}>POINTS</Text>
      {balance > 0 ? (
        <>
          <Text style={styles.pointsBalance}>
            Balance {balance.toLocaleString()} pts · worth {formatCents(pointsToCents(balance, centsPerPoint))}
          </Text>
          {!availableKnown ? (
            <Text style={styles.pointsMaturing}>Checking available points…</Text>
          ) : maturing > 0 ? (
            // Named rather than silently subtracted, or the cashier sees a
            // "Use max" that doesn't match the balance right above it.
            <Text style={styles.pointsMaturing}>
              {maturing.toLocaleString()} still maturing · {spendable.toLocaleString()} can be used today
            </Text>
          ) : null}
          <View style={styles.pointsRow}>
            <TextInput
              value={draft}
              onChangeText={commit}
              placeholder="0"
              placeholderTextColor="#9B9B9B"
              keyboardType="number-pad"
              style={styles.pointsInput}
            />
            <Pressable
              onPress={() => onChange(maxRedeemable)}
              disabled={maxRedeemable <= 0}
              style={[styles.useMax, maxRedeemable <= 0 && styles.useMaxDisabled]}
            >
              <Text style={styles.useMaxText}>Use max ({maxRedeemable.toLocaleString()})</Text>
            </Pressable>
          </View>
          {effectivePoints > 0 && (
            // The EFFECTIVE figure, not what was typed: an over-entry gets
            // visibly corrected here rather than silently ignored.
            <Text style={[styles.pointsUsing, overEntered && styles.pointsClamped]}>
              Using {effectivePoints.toLocaleString()} pts — {formatCents(redemptionCents)} off
              {overEntered ? ' (the most this sale can take)' : ''}
            </Text>
          )}
        </>
      ) : (
        <Text style={styles.pointsBalance}>No points yet.</Text>
      )}
      {pointsEarned > 0 && <Text style={styles.pointsEarns}>Earns {formatPoints(pointsEarned)} on this sale.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  // The sale's primary action: 56px, full width, black. Nothing else on the
  // sheet competes with it.
  checkout: { backgroundColor: theme.bentoInk, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  checkoutDisabled: { backgroundColor: theme.bentoSoft },
  checkoutText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 16, letterSpacing: -0.2 },
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  // The sheet is the PAGE, not a card — the blocks inside it are the cards, and
  // a white sheet would flatten them into it.
  // `height`, not `maxHeight` -- `sheetScroll` below is `flex: 1` and needs a
  // concrete parent size to fill. Against a content-sized parent it resolves to
  // zero and scrolls nothing, which is the trap receipt-modal.tsx records.
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, paddingBottom: 20, height: '88%' },
  sheetScroll: { flex: 1 },
  sheetScrollContent: { paddingBottom: 12 },
  sheetFoot: { paddingTop: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  close: { backgroundColor: theme.bentoSurface, borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  completeSale: {},
  sheetHint: { color: theme.bentoMuted, fontSize: 11.5, textAlign: 'center', marginTop: 9 },
  error: { color: theme.bentoLoss, fontSize: 13, fontWeight: '700', marginTop: 10 },
  pointsSection: { backgroundColor: theme.bentoSurface, borderRadius: 16, padding: 14, marginTop: 8 },
  pointsLabel: { fontSize: 10.5, letterSpacing: 0.7, fontWeight: '800', color: theme.bentoMuted, marginBottom: 9, textTransform: 'uppercase' },
  pointsBalance: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
  pointsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  pointsInput: { backgroundColor: theme.bentoSoft, borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 12, height: 44, paddingHorizontal: 12, color: theme.bentoInk, flex: 1 },
  useMax: { backgroundColor: theme.bentoSoft, borderWidth: 1, borderColor: theme.bentoLine, height: 44, paddingHorizontal: 15, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  useMaxDisabled: { opacity: 0.45 },
  useMaxText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  pointsUsing: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk, marginTop: 8 },
  // Warm on purpose — a clamp is a mild warning, and cooling it to match the
  // palette would cost it the flag it carries.
  pointsClamped: { color: '#8A530F' },
  pointsEarns: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 6 },
  pointsMaturing: { fontSize: 11.5, color: '#8A530F', fontWeight: '700', marginTop: 4 },
});
