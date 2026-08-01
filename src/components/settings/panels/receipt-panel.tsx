import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { EditableTextRow, PageHeader, Row, Section, Toggle } from '@/components/settings/settings-primitives';
import { updateShop } from '@/lib/shops';
import type { Shop } from '@/types/models';

// Only "Footer message" is real today — it's the same data as Store's
// Return Policy field (`shop.returnPolicy`), which already prints at the
// bottom of every receipt. Everything else here is a Phase 2 placeholder:
// local state only, no backing column, not persisted.
export function ReceiptPanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [returnPolicy, setReturnPolicy] = useState(shop.returnPolicy ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showLogo, setShowLogo] = useState(true);
  const [showCashierName, setShowCashierName] = useState(true);
  const [arabicText, setArabicText] = useState(false);
  const [sendWhatsApp, setSendWhatsApp] = useState(false);
  const [autoPrint, setAutoPrint] = useState(false);

  const dirty = returnPolicy.trim() !== (shop.returnPolicy ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, { returnPolicy: returnPolicy.trim() });
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
        <Row label="Arabic text on receipt" desc="Add a second line in Arabic">
          <Toggle value={arabicText} onValueChange={setArabicText} />
        </Row>
      </Section>
      <Section title="Sharing">
        <Row label="Send via WhatsApp" desc="Share receipt link after every sale">
          <Toggle value={sendWhatsApp} onValueChange={setSendWhatsApp} />
        </Row>
        <Row label="Print receipt" desc="Auto-print after checkout">
          <Toggle value={autoPrint} onValueChange={setAutoPrint} />
        </Row>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
});
