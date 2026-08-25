import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { StorePicker } from '@/components/store-picker';
import { VendorPicker, type SelectedVendor } from '@/components/vendor-picker';
import { formatAccountingCents, toCents } from '@/lib/currency';
import { EXPENSE_CATEGORIES } from '@/lib/expense-reporting';
import { toDateColumn } from '@/lib/period';
import { listUnbilledDeliveries } from '@/lib/stock-receipts';
import type { ExpenseCategory, Invoice, NewInvoiceInput, UnbilledDelivery } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

// One modal for raising and editing a vendor bill. Mounted only while editing
// and keyed by id, so fields initialise from props without an effect.
export function InvoiceEditorModal({
  shopId,
  invoice,
  onClose,
  onSave,
  onDelete,
}: {
  shopId: string;
  invoice: Invoice | null;
  onClose: () => void;
  onSave: (input: NewInvoiceInput) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [vendor, setVendor] = useState<SelectedVendor | null>(
    invoice?.vendorId ? { id: invoice.vendorId, name: invoice.vendorName ?? 'Vendor' } : null
  );
  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber ?? '');
  const [category, setCategory] = useState<ExpenseCategory>(invoice?.category ?? 'inventory_purchase');
  const [description, setDescription] = useState(invoice?.description ?? '');
  const [issuedOn, setIssuedOn] = useState(invoice?.issuedOn ?? toDateColumn(new Date()));
  const [dueOn, setDueOn] = useState(invoice?.dueOn ?? '');
  const [amount, setAmount] = useState(invoice ? (invoice.amountCents / 100).toFixed(2) : '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(invoice?.locationId ?? null);
  const [saving, setSaving] = useState(false);

  // WHICH DELIVERY THIS BILL PAYS FOR.
  //
  // Set once, when the bill is entered, and immutable afterwards — the database
  // refuses to change it (20260908001900). A bill carrying one posts nothing to
  // the ledger, because receive_stock already posted Dr 1200 / Cr 2000 for those
  // goods and paying this bill clears that payable.
  //
  // It is offered on EVERY category, not only on Inventory restock. The failure
  // it closes in the other direction is a bill for goods entered under Supplies
  // — one wrong tap — which used to post its cost a second time and double the
  // payable. A field that only appeared for the goods category would never be
  // shown to the person making exactly that mistake.
  const [deliveryId, setDeliveryId] = useState<string | null>(invoice?.stockReceiptId ?? null);
  const [deliveries, setDeliveries] = useState<UnbilledDelivery[] | null>(null);

  // Only for a NEW bill. An existing one's link cannot move, so a list of
  // alternatives would be a control that looks like it fixes something and does
  // not. Its own delivery is named in words instead, below.
  useEffect(() => {
    if (invoice) return;
    let live = true;
    listUnbilledDeliveries(shopId)
      .then((rows) => { if (live) setDeliveries(rows); })
      // Failing to an EMPTY LIST, not to null. Null means "still loading" and
      // would leave the goods branch below saying nothing at all; an empty list
      // is the honest answer to "what can I link to" when the question could not
      // be answered, and it is the one that keeps Save refused.
      .catch(() => { if (live) setDeliveries([]); });
    return () => { live = false; };
  }, [shopId, invoice]);

  const amountCents = toCents(amount);
  const issuedDate = parseDateInput(issuedOn);
  const dueDate = parseDateInput(dueOn);
  const selectedDelivery = deliveries?.find((d) => d.id === deliveryId) ?? null;
  // A goods bill has to name a delivery, and the database enforces it. Blocking
  // Save here as well is not belt and braces: the alternative is a form that
  // takes everything the person typed, sends it, and hands back a paragraph.
  const needsDelivery = !invoice && category === 'inventory_purchase' && deliveryId === null;
  // The delivery credited Accounts Payable by its costed value; paying the bill
  // debits it by the bill's. A difference sits in the payable for ever, so it is
  // named rather than blocked — carriage and rounding are real money and
  // refusing to record them would be worse.
  const linkedAmountDiffers =
    selectedDelivery !== null && amountCents > 0 && amountCents !== selectedDelivery.valueCents;
  // The DB has no constraint that due >= issued (a shop may legitimately be
  // handed a bill already past due), so this is guidance rather than a block.
  const dueBeforeIssued = Boolean(issuedDate && dueDate && dueDate < issuedDate);
  // Reducing a bill below what's already been paid would violate the
  // not-overpaid constraint; catching it here explains why rather than
  // surfacing a raw Postgres error.
  const belowPaid = invoice ? amountCents < invoice.paidCents : false;

  const canSave =
    amountCents > 0 && Boolean(invoiceNumber.trim()) && Boolean(issuedDate) && Boolean(dueDate)
    && !belowPaid && !needsDelivery && !saving;

  // Picking a delivery fills the amount from what that delivery cost, because
  // the payable already standing against it is exactly that figure. Only when
  // the field is still empty — retyping over what somebody entered would be the
  // form arguing with them.
  const pickDelivery = (delivery: UnbilledDelivery | null) => {
    setDeliveryId(delivery?.id ?? null);
    if (delivery && delivery.valueCents > 0 && toCents(amount) === 0) {
      setAmount((delivery.valueCents / 100).toFixed(2));
    }
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        locationId,
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? null,
        vendorPhone: null,
        invoiceNumber: invoiceNumber.trim(),
        category,
        description: description.trim() || null,
        issuedOn,
        dueOn,
        amountCents,
        stockReceiptId: deliveryId,
      });
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this bill.'));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not delete this bill.'));
      setSaving(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{invoice ? 'Edit bill' : 'New bill'}</Text>
            <View style={styles.headerActions}>
              <Pressable onPress={save} disabled={!canSave} testID="invoice-save-header" style={[styles.primaryButton, !canSave && styles.buttonDisabled]}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView style={styles.body}>
            <VendorPicker
              shopId={shopId}
              selected={vendor}
              onSelect={setVendor}
              onClear={() => setVendor(null)}
              label="Who the bill is from"
            />

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>BILL NUMBER</Text>
                <TextInput
                  value={invoiceNumber}
                  onChangeText={setInvoiceNumber}
                  placeholder="Their reference"
                  placeholderTextColor="#9B9B9B"
                  style={styles.input}
                />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>AMOUNT</Text>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  placeholderTextColor="#9B9B9B"
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
              </View>
            </View>

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>ISSUED</Text>
                <DateInput value={issuedOn} onChangeText={setIssuedOn} />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>DUE</Text>
                <DateInput value={dueOn} onChangeText={setDueOn} />
              </View>
            </View>
            {dueBeforeIssued && <Text style={styles.warning}>This bill is due before it was issued — it will show as overdue.</Text>}
            {belowPaid && invoice && (
              <Text style={styles.warning}>
                Can&apos;t be less than the {(invoice.paidCents / 100).toFixed(2)} already paid against it.
              </Text>
            )}

            <StorePicker value={locationId} onChange={setLocationId} />

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>WHICH DELIVERY THIS BILL IS FOR</Text>
            {invoice ? (
              // AN EXISTING BILL. The link is final, so this states it and
              // offers nothing. A picker here would look like a remedy and be
              // none — and the remedies that do work are named in words.
              <Text style={styles.note} testID="invoice-delivery-fixed">
                {invoice.stockReceiptId
                  ? 'This bill is against a delivery you received, so it did not add to your stock value again — paying it clears what you owed for that delivery. Which delivery a bill is for is fixed when the bill is entered.'
                  : category === 'inventory_purchase'
                    ? 'This bill names no delivery, so nothing was ever recorded as owed for it — paying it pushes Accounts Payable the wrong way. Record the delivery in Inventory, or delete this bill and enter it again against one. The link cannot be added afterwards.'
                    : 'This bill names no delivery. Which delivery a bill is for is fixed when the bill is entered and cannot be changed afterwards.'}
              </Text>
            ) : (
              <View style={styles.pick}>
                {(deliveries ?? []).map((delivery) => {
                  const active = delivery.id === deliveryId;
                  const uncosted = delivery.valueCents === 0;
                  return (
                    <Pressable
                      key={delivery.id}
                      onPress={() => pickDelivery(delivery)}
                      style={styles.pickRow}
                      testID={`invoice-delivery-${delivery.id}`}
                    >
                      <View style={styles.pickMain}>
                        <Text style={styles.pickTitle} numberOfLines={1}>
                          {[delivery.supplierName, delivery.reference].filter(Boolean).join(' · ') || 'Delivery'}
                        </Text>
                        <Text style={styles.pickMeta} numberOfLines={1}>
                          {`${delivery.receivedAt.slice(0, 10)} · ${delivery.itemCount} item${delivery.itemCount === 1 ? '' : 's'}`}
                          {uncosted ? ' · no cost recorded' : ''}
                        </Text>
                      </View>
                      <Text style={[styles.pickValue, uncosted && styles.pickValueMuted]}>
                        {uncosted ? '—' : formatAccountingCents(delivery.valueCents)}
                      </Text>
                      {active && <Text style={styles.pickTick}>✓</Text>}
                    </Pressable>
                  );
                })}
                {/* Always last, so it is the one row that carries no rule under
                    it — React Native has no :last-child and a stray hairline
                    across the bottom of the panel reads as a missing row. */}
                <Pressable onPress={() => pickDelivery(null)} style={[styles.pickRow, styles.pickRowLast]} testID="invoice-delivery-none">
                  <View style={styles.pickMain}>
                    <Text style={styles.pickTitle}>
                      {deliveries !== null && deliveries.length === 0 ? 'No deliveries waiting for a bill' : 'Not for a delivery'}
                    </Text>
                    <Text style={styles.pickMeta} numberOfLines={2}>
                      {deliveries === null
                        ? 'Loading your deliveries…'
                        : deliveries.length === 0
                          ? 'Every delivery you have received is already on a bill'
                          : 'Rent, utilities, transport — anything that is not goods'}
                    </Text>
                  </View>
                  {deliveryId === null && <Text style={styles.pickTick}>✓</Text>}
                </Pressable>
              </View>
            )}
            {/* Two different sentences, because they need two different next
                steps. Nothing to link at all → go and receive the delivery. A
                delivery is picked but was received with no costs on it → it
                reached no book either, so there is no payable for this bill to
                settle and the database will refuse the link. */}
            {needsDelivery && (
              <Text style={styles.warning} testID="invoice-delivery-required">
                {deliveries !== null && deliveries.length === 0
                  ? 'A stock purchase has to say which delivery it pays for, so your stock and your books agree about the same goods — and no delivery is waiting for a bill. Receive it in Inventory first, then enter this bill against it. Or, if this bill is not for goods, change what it’s for.'
                  : 'A stock purchase has to say which delivery it pays for, so your stock and your books agree about the same goods. Pick the delivery above — or, if this bill is not for goods, change what it’s for.'}
              </Text>
            )}
            {selectedDelivery !== null && selectedDelivery.valueCents === 0 && (
              <Text style={styles.warning} testID="invoice-delivery-uncosted">
                That delivery was received without any costs on it, so it never reached your books — there is nothing
                owed against it for this bill to settle. Receive it again with what it cost, and enter this bill
                against that one.
              </Text>
            )}
            {linkedAmountDiffers && (
              <Text style={styles.warning} testID="invoice-delivery-amount-differs">
                {`That delivery was valued at ${formatAccountingCents(selectedDelivery!.valueCents)}. Paying ${formatAccountingCents(amountCents)} will leave ${formatAccountingCents(Math.abs(amountCents - selectedDelivery!.valueCents))} ${amountCents > selectedDelivery!.valueCents ? 'sitting in' : 'missing from'} what you owe suppliers.`}
              </Text>
            )}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>WHAT IT&apos;S FOR</Text>
            <View style={styles.chipRow}>
              {EXPENSE_CATEGORIES.map((option) => {
                const active = option.key === category;
                return (
                  <Pressable key={option.key} onPress={() => setCategory(option.key)} style={[styles.chip, active && styles.chipActive]}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>DESCRIPTION</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="e.g. Bulk restock — 40pc assorted"
              placeholderTextColor="#9B9B9B"
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.multiline]}
            />

            {/* Two endings, because a bill against a delivery does NOT reach
                the P&L a second time: the goods are already on the balance
                sheet at what they cost, and that cost becomes profit-affecting
                when they sell. Saying "this counts against profit" for one of
                those would be the screen describing an entry the ledger does
                not write. */}
            <Text style={styles.note}>
              {deliveryId !== null
                ? 'This bill is for a delivery you already received, so it does not add to your stock value again — those goods are already on your books at what they cost. Paying it clears what you owed for that delivery.'
                : 'Recording a bill adds it to expenses straight away, so it counts against profit from the day it was issued. Paying it later settles the balance without changing your profit again.'}
            </Text>

            {error && <Text style={styles.error}>{error}</Text>}

            <View style={styles.formActions}>
              {onDelete ? (
                confirmingDelete ? (
                  <View style={styles.confirmRow}>
                    <Text style={styles.confirmText}>Delete this bill and its expense?</Text>
                    <Pressable onPress={remove} disabled={saving}><Text style={styles.dangerText}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving}><Text style={styles.mutedText}>Cancel</Text></Pressable>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving}>
                    <Text style={styles.dangerText}>Delete bill</Text>
                  </Pressable>
                )
              ) : (
                <View />
              )}
              <Pressable onPress={save} disabled={!canSave} testID="invoice-save" style={[styles.primaryButton, !canSave && styles.buttonDisabled]}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const message = (err as { message: string }).message;
    if (message.includes('invoices_shop_id_invoice_number_key')) return 'A bill with that number already exists.';
    if (message.includes('invoices_not_overpaid')) return 'That amount is less than what has already been paid.';
    return message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '88%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  body: { flexGrow: 0 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  fieldLabelSpaced: { marginTop: 16 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  multiline: { height: 72, paddingTop: 11 },
  // The delivery picker, styled as the form's own inset panel rather than as a
  // list of buttons: it is one field with several possible values, and it sits
  // between two fields that read as grey wells.
  pick: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 12 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#E4E4E4' },
  pickRowLast: { borderBottomWidth: 0 },
  pickMain: { flex: 1, minWidth: 0 },
  pickTitle: { fontSize: 12.5, fontWeight: '700', color: '#111111' },
  pickMeta: { fontSize: 11, color: '#9B9B9B', marginTop: 2 },
  pickValue: { fontSize: 12.5, fontWeight: '800', color: '#111111' },
  pickValueMuted: { color: '#9B9B9B' },
  pickTick: { fontSize: 12, fontWeight: '800', color: '#438254' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '700', color: '#777777' },
  chipTextActive: { color: '#FFFFFF' },
  note: { fontSize: 11, color: '#999999', lineHeight: 16, marginTop: 16 },
  warning: { fontSize: 11, color: '#B5793A', fontWeight: '600', marginTop: 8 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 12 },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 20 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  confirmText: { fontSize: 12, fontWeight: '600', color: '#111111', flexShrink: 1 },
  dangerText: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  mutedText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
