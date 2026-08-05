import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { formatCents } from '@/lib/currency';
import { formatPoints, pointsToCents } from '@/lib/loyalty';
import type { Currency, PaymentLine, PaymentMethod } from '@/types/models';

// Cashier/customer/payment live in a bottom-sheet modal behind a single
// "Checkout" button rather than inline in the cart pane, so the cart pane
// (pinned above the product grid on mobile, its line-item list height-
// capped) stays a fixed size regardless of checkout state.
export function CheckoutPanel({
  cartEmpty,
  cashiers,
  cashierName,
  onSelectCashier,
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
}: {
  cartEmpty: boolean;
  cashiers: string[];
  cashierName: string | null;
  onSelectCashier: (name: string) => void;
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
}) {
  const [open, setOpen] = useState(false);

  // Covers both a completed sale (pos.tsx clears the cart on success) and
  // the cart being emptied manually mid-flow -- either way there's nothing
  // left to check out, so the sheet shouldn't stay open.
  useEffect(() => {
    if (cartEmpty) setOpen(false);
  }, [cartEmpty]);

  return (
    <>
      <Pressable onPress={() => setOpen(true)} disabled={cartEmpty} style={[styles.checkout, cartEmpty && styles.checkoutDisabled]}>
        <Text style={styles.checkoutText}>Checkout</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.header}>
              <Text style={styles.title}>Checkout</Text>
              <Pressable onPress={() => setOpen(false)} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled">
              {cashiers.length > 0 && (
                <View style={styles.cashierSection}>
                  <Text style={styles.cashierLabel}>CASHIER</Text>
                  <View style={styles.cashierChips}>
                    {cashiers.map((name) => (
                      <CategoryChip key={name} label={name} active={cashierName === name} onPress={() => onSelectCashier(name)} />
                    ))}
                  </View>
                </View>
              )}

              <CustomerPicker
                shopId={shopId}
                selected={selectedCustomer}
                onSelect={onSelectCustomer}
                onClear={onClearCustomer}
                showPoints={loyaltyEnabled}
                centsPerPoint={centsPerPoint}
              />

              {/* Between the customer and the payment on purpose. The sheet
                  reads top to bottom, and entering points changes the total,
                  which clears whatever split has been entered -- so points have
                  to be spent before the money is counted, not after. */}
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

              <PaymentMethodPicker
                totalCents={totalCents}
                payments={payments}
                currencies={currencies}
                onChange={onChangePayments}
                enabledMethods={enabledPaymentMethods}
                allowSplit={allowSplit}
              />

              {error && <Text style={styles.error}>{error}</Text>}

              <Pressable
                onPress={onCheckout}
                disabled={cartEmpty || !fullyPaid || submitting}
                style={[styles.checkout, styles.completeSale, (cartEmpty || !fullyPaid || submitting) && styles.checkoutDisabled]}
              >
                <Text style={styles.checkoutText}>{submitting ? 'Completing…' : 'Complete sale'}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

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
  checkout: { backgroundColor: '#111111', height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  checkoutDisabled: { backgroundColor: '#CCCCCC' },
  checkoutText: { color: '#FFFFFF', fontWeight: '800', fontSize: 16 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: '85%' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  cashierSection: { marginTop: 0, marginBottom: 4 },
  cashierLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 8 },
  cashierChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  completeSale: { marginBottom: 8 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 10 },
  pointsSection: { marginTop: 16 },
  pointsLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 8 },
  pointsBalance: { fontSize: 12, fontWeight: '700', color: '#111111' },
  pointsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  pointsInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111', flex: 1 },
  useMax: { backgroundColor: '#F2F2F2', height: 42, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  useMaxDisabled: { opacity: 0.45 },
  useMaxText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  pointsUsing: { fontSize: 12, fontWeight: '700', color: '#111111', marginTop: 8 },
  pointsClamped: { color: '#9A6700' },
  pointsEarns: { fontSize: 11, color: '#999999', marginTop: 6 },
  pointsMaturing: { fontSize: 11, color: '#9A6700', fontWeight: '700', marginTop: 4 },
});
