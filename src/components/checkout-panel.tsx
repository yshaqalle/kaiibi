import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { CustomerPicker, type SelectedCustomer } from '@/components/customer-picker';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
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

              <CustomerPicker shopId={shopId} selected={selectedCustomer} onSelect={onSelectCustomer} onClear={onClearCustomer} />

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
});
