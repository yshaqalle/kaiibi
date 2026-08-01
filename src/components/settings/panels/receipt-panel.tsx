import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { EditableTextRow, PageHeader, Row, Section, Toggle } from '@/components/settings/settings-primitives';
import { updateShop } from '@/lib/shops';
import type { Shop } from '@/types/models';

// All fields here are real and persisted (shops.receipt_* columns, migration
// 0026): "Show logo"/"Show cashier name" are read by buildReceiptFromSale
// (src/lib/receipt.ts) and pos.tsx's inline ReceiptData construction; "Send
// via WhatsApp"/"Print receipt" are read by ReceiptModal to auto-trigger
// once right after checkout (see pos.tsx). "Footer message" is the same
// field as Store's Return Policy (`shop.returnPolicy`).
export function ReceiptPanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [returnPolicy, setReturnPolicy] = useState(shop.returnPolicy ?? '');
  const [showLogo, setShowLogo] = useState(shop.receiptShowLogo);
  const [showCashierName, setShowCashierName] = useState(shop.receiptShowCashierName);
  const [autoWhatsapp, setAutoWhatsapp] = useState(shop.receiptAutoWhatsapp);
  const [autoPrint, setAutoPrint] = useState(shop.receiptAutoPrint);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    returnPolicy.trim() !== (shop.returnPolicy ?? '') ||
    showLogo !== shop.receiptShowLogo ||
    showCashierName !== shop.receiptShowCashierName ||
    autoWhatsapp !== shop.receiptAutoWhatsapp ||
    autoPrint !== shop.receiptAutoPrint;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, {
        returnPolicy: returnPolicy.trim(),
        receiptShowLogo: showLogo,
        receiptShowCashierName: showCashierName,
        receiptAutoWhatsapp: autoWhatsapp,
        receiptAutoPrint: autoPrint,
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <PageHeader title="Receipt" actionLabel={saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'} onAction={save} actionDisabled={!dirty || saving} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Receipt content">
        <Row label="Show logo">
          <Toggle value={showLogo} onValueChange={setShowLogo} />
        </Row>
        <Row label="Show cashier name" desc='Appears as "Served by"'>
          <Toggle value={showCashierName} onValueChange={setShowCashierName} />
        </Row>
        <EditableTextRow
          label="Footer message"
          value={returnPolicy}
          onChangeText={setReturnPolicy}
          placeholder="e.g. Returns accepted within 7 days with receipt."
          multiline
        />
      </Section>
      <Section title="Sharing">
        <Row label="Send via WhatsApp" desc="Share receipt link after every sale (only when a customer phone was captured)">
          <Toggle value={autoWhatsapp} onValueChange={setAutoWhatsapp} />
        </Row>
        <Row label="Print receipt" desc="Auto-print after checkout (web only)">
          <Toggle value={autoPrint} onValueChange={setAutoPrint} />
        </Row>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
});
