import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, EditableTextRow, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { updateShop, uploadShopLogo } from '@/lib/shops';
import { deleteImageByPublicUrl } from '@/lib/storage';
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

// What the BUSINESS is, of which there is exactly one: its name, logo,
// description, return policy, revenue goal and pay cycle. Deliberately carries
// no address, phone or hours — those belong to a place, and a business trades
// from one or more of them. They live on the store location (migration
// 20260811000000), which is also what a receipt prints and what a sale, a stock
// count and a shift point at.
export function BusinessPanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(shop.name ?? '');
  const [description, setDescription] = useState(shop.description ?? '');
  const [returnPolicy, setReturnPolicy] = useState(shop.returnPolicy ?? '');
  const [logoUri, setLogoUri] = useState<string | null>(shop.logoUrl);
  const [payPeriodAnchor, setPayPeriodAnchor] = useState(shop.payPeriodAnchor ?? '');
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name.trim() !== (shop.name ?? '') ||
    description.trim() !== (shop.description ?? '') ||
    returnPolicy.trim() !== (shop.returnPolicy ?? '') ||
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
      // Only set when this save is actually replacing an uploaded photo --
      // gates the cleanup below so a plain-fields save or a "remove logo"
      // (logoUrl set to null, no new upload) never tries to delete anything.
      let replacedLogoUrl: string | null = null;
      if (logoUri && !/^https?:\/\//.test(logoUri)) {
        setUploadingLogo(true);
        logoUrl = await uploadShopLogo(shop.id, logoUri);
        setUploadingLogo(false);
        replacedLogoUrl = shop.logoUrl;
      } else if (logoUri === null) {
        logoUrl = null;
      }
      await updateShop(shop.id, {
        name: name.trim(),
        description: description.trim(),
        returnPolicy: returnPolicy.trim(),
        logoUrl,
        payPeriodAnchor: payPeriodAnchor.trim() || null,
      });
      // Only after the new URL is safely persisted -- see storage.ts.
      if (replacedLogoUrl) await deleteImageByPublicUrl(replacedLogoUrl);
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
        title="Business"
        actionLabel={saving || uploadingLogo ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
        onAction={save}
        actionDisabled={!dirty || saving || uploadingLogo}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Business details">
        <Text style={styles.addressHint}>
          Your address, phone, opening hours and revenue goal belong to each store — set them under Settings → Store
          locations.
        </Text>
        <LogoRow logoUri={logoUri} onPick={pickLogo} onRemove={() => setLogoUri(null)} />
        <EditableTextRow label="Business name" value={name} onChangeText={setName} placeholder="Business name" />
        <EditableTextRow label="Description" value={description} onChangeText={setDescription} placeholder="A short description of your store" multiline />
        <EditableTextRow
          label="Return policy"
          value={returnPolicy}
          onChangeText={setReturnPolicy}
          placeholder="e.g. Returns accepted within 7 days with receipt."
          multiline
        />
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
  addressHint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  logoPreview: { width: 36, height: 36, borderRadius: 8 },
});
