import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, EditableTextRow, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { toCents } from '@/lib/currency';
import { updateShop, uploadShopLogo } from '@/lib/shops';
import type { Shop } from '@/types/models';

function LogoRow({ logoUri, onPick, onRemove }: { logoUri: string | null; onPick: () => void; onRemove: () => void }) {
  return (
    <Row label="Logo" desc={logoUri ? undefined : 'No logo uploaded'}>
      {logoUri && (
        <Pressable onPress={onPick}>
          <Image source={{ uri: logoUri }} contentFit="cover" style={styles.logoPreview} />
        </Pressable>
      )}
      <Btn onPress={onPick}>{logoUri ? 'Replace' : 'Add logo'}</Btn>
      {logoUri && (
        <Btn danger onPress={onRemove}>
          Remove
        </Btn>
      )}
    </Row>
  );
}

export function StorePanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(shop.name ?? '');
  const [contactPhone, setContactPhone] = useState(shop.contactPhone ?? '');
  const [city, setCity] = useState(shop.city ?? '');
  const [neighborhood, setNeighborhood] = useState(shop.neighborhood ?? '');
  const [description, setDescription] = useState(shop.description ?? '');
  const [returnPolicy, setReturnPolicy] = useState(shop.returnPolicy ?? '');
  const shopGoalInput = shop.monthlyRevenueGoalCents != null ? String(shop.monthlyRevenueGoalCents / 100) : '';
  const [goalInput, setGoalInput] = useState(shopGoalInput);
  const [logoUri, setLogoUri] = useState<string | null>(shop.logoUrl);
  const [payPeriodAnchor, setPayPeriodAnchor] = useState(shop.payPeriodAnchor ?? '');
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name.trim() !== (shop.name ?? '') ||
    contactPhone.trim() !== (shop.contactPhone ?? '') ||
    city.trim() !== (shop.city ?? '') ||
    neighborhood.trim() !== (shop.neighborhood ?? '') ||
    description.trim() !== (shop.description ?? '') ||
    returnPolicy.trim() !== (shop.returnPolicy ?? '') ||
    goalInput.trim() !== shopGoalInput ||
    logoUri !== shop.logoUrl ||
    payPeriodAnchor.trim() !== (shop.payPeriodAnchor ?? '');

  const pickLogo = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    if (!result.canceled) setLogoUri(result.assets[0].uri);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let logoUrl = shop.logoUrl;
      if (logoUri && !/^https?:\/\//.test(logoUri)) {
        setUploadingLogo(true);
        logoUrl = await uploadShopLogo(shop.id, logoUri);
        setUploadingLogo(false);
      } else if (logoUri === null) {
        logoUrl = null;
      }
      await updateShop(shop.id, {
        name: name.trim(),
        contactPhone: contactPhone.trim(),
        city: city.trim(),
        neighborhood: neighborhood.trim(),
        description: description.trim(),
        returnPolicy: returnPolicy.trim(),
        monthlyRevenueGoalCents: goalInput.trim() ? toCents(goalInput) : null,
        logoUrl,
        payPeriodAnchor: payPeriodAnchor.trim() || null,
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setUploadingLogo(false);
      setSaving(false);
    }
  };

  return (
    <View>
      <PageHeader
        title="Store"
        actionLabel={saving || uploadingLogo ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
        onAction={save}
        actionDisabled={!dirty || saving || uploadingLogo}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Store details">
        <LogoRow logoUri={logoUri} onPick={pickLogo} onRemove={() => setLogoUri(null)} />
        <EditableTextRow label="Store name" value={name} onChangeText={setName} placeholder="Store name" />
        <EditableTextRow label="Description" value={description} onChangeText={setDescription} placeholder="A short description of your store" multiline />
        {/* The business's registered details. What a receipt prints is the
            SELLING LOCATION's address, phone and hours — edit those under
            Settings → Locations. */}
        <EditableTextRow label="City" value={city} onChangeText={setCity} placeholder="City" />
        <EditableTextRow label="Neighborhood" value={neighborhood} onChangeText={setNeighborhood} placeholder="Neighborhood or landmark" />
        <EditableTextRow label="Contact phone" value={contactPhone} onChangeText={setContactPhone} placeholder="Phone number" keyboardType="phone-pad" />
        <EditableTextRow
          label="Return policy"
          value={returnPolicy}
          onChangeText={setReturnPolicy}
          placeholder="e.g. Returns accepted within 7 days with receipt."
          multiline
        />
        <EditableTextRow label="Monthly revenue goal" value={goalInput} onChangeText={setGoalInput} placeholder="e.g. 5000" keyboardType="decimal-pad" />
      </Section>
      <Section title="Payroll">
        <EditableTextRow
          label="Pay period start"
          value={payPeriodAnchor}
          onChangeText={setPayPeriodAnchor}
          placeholder="YYYY-MM-DD"
        />
      </Section>
      <Section title="Social links">
        {/* Phase 2 placeholders — no social link fields on the shop model yet. */}
        <Row label="Instagram" desc="Not connected">
          <Btn onPress={() => {}}>Add</Btn>
        </Row>
        <Row label="TikTok" desc="Not connected">
          <Btn onPress={() => {}}>Add</Btn>
        </Row>
        <Row label="WhatsApp Business" desc="Not connected">
          <Btn onPress={() => {}}>Add</Btn>
        </Row>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
  logoPreview: { width: 36, height: 36, borderRadius: 8 },
});
