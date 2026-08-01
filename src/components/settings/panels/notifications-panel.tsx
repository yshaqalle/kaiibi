import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PageHeader, Row, Section, Toggle } from '@/components/settings/settings-primitives';
import { updateShop } from '@/lib/shops';
import type { Shop } from '@/types/models';

// Every toggle here is real and persisted (shops.notify_* columns,
// migration 0029) — but these are preferences only. Nothing in the app
// currently sends a daily summary, low-stock alert, or push/email/WhatsApp
// notification; there's no push-token registration, no scheduled job, and
// no email/WhatsApp provider integration anywhere in the codebase yet. See
// docs/backlog for what building real delivery would take.
export function NotificationsPanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [dailySummary, setDailySummary] = useState(shop.notifyDailySummary);
  const [largeSaleAlert, setLargeSaleAlert] = useState(shop.notifyLargeSale);
  const [lowStockWarning, setLowStockWarning] = useState(shop.notifyLowStock);
  const [outOfStock, setOutOfStock] = useState(shop.notifyOutOfStock);
  const [pushEnabled, setPushEnabled] = useState(shop.notifyViaPush);
  const [emailEnabled, setEmailEnabled] = useState(shop.notifyViaEmail);
  const [whatsAppEnabled, setWhatsAppEnabled] = useState(shop.notifyViaWhatsapp);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    dailySummary !== shop.notifyDailySummary ||
    largeSaleAlert !== shop.notifyLargeSale ||
    lowStockWarning !== shop.notifyLowStock ||
    outOfStock !== shop.notifyOutOfStock ||
    pushEnabled !== shop.notifyViaPush ||
    emailEnabled !== shop.notifyViaEmail ||
    whatsAppEnabled !== shop.notifyViaWhatsapp;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, {
        notifyDailySummary: dailySummary,
        notifyLargeSale: largeSaleAlert,
        notifyLowStock: lowStockWarning,
        notifyOutOfStock: outOfStock,
        notifyViaPush: pushEnabled,
        notifyViaEmail: emailEnabled,
        notifyViaWhatsapp: whatsAppEnabled,
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
      <PageHeader title="Notifications" actionLabel={saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'} onAction={save} actionDisabled={!dirty || saving} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Sales alerts">
        <Row label="Daily sales summary" desc="Sent every evening at 8 PM">
          <Toggle value={dailySummary} onValueChange={setDailySummary} />
        </Row>
        <Row label="Large sale alert" desc="Notify when a single sale exceeds $100">
          <Toggle value={largeSaleAlert} onValueChange={setLargeSaleAlert} />
        </Row>
      </Section>
      <Section title="Inventory alerts">
        <Row label="Low stock warning" desc="Alert when stock drops below threshold">
          <Toggle value={lowStockWarning} onValueChange={setLowStockWarning} />
        </Row>
        <Row label="Out of stock" desc="Immediate push notification">
          <Toggle value={outOfStock} onValueChange={setOutOfStock} />
        </Row>
      </Section>
      <Section title="Delivery channel">
        <Row label="Push notifications">
          <Toggle value={pushEnabled} onValueChange={setPushEnabled} />
        </Row>
        <Row label="Email">
          <Toggle value={emailEnabled} onValueChange={setEmailEnabled} />
        </Row>
        <Row label="WhatsApp" desc="Send summaries to your WhatsApp number">
          <Toggle value={whatsAppEnabled} onValueChange={setWhatsAppEnabled} />
        </Row>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
});
