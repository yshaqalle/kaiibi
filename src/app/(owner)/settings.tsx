import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CategoryChip } from '@/components/category-chip';
import { ScreenHeader } from '@/components/screen-header';
import { SegmentedControl } from '@/components/segmented-control';
import { TaxonomyManageModal, type TaxonomyInput, type TaxonomyRow } from '@/components/taxonomy-manage-modal';
import { useAuth } from '@/hooks/use-auth';
import { createBrand, deleteBrand, listBrands, renameBrand, updateBrand, uploadBrandImage } from '@/lib/brands';
import { createCashier, deleteCashier, listCashiers, renameCashier } from '@/lib/cashiers';
import { createCategory, deleteCategory, listCategories, renameCategory, updateCategory, uploadCategoryImage } from '@/lib/categories';
import { nextTaxonomyColor, taxonomyPalette } from '@/lib/colors';
import { createCurrency, deleteCurrency, listCurrencies, setCurrencyActive, updateCurrency } from '@/lib/currencies';
import { formatCents, toCents } from '@/lib/currency';
import { updateProfile } from '@/lib/profile';
import { listProducts } from '@/lib/products';
import { createPromotion, deletePromotion, listPromotions, updatePromotion } from '@/lib/promotions';
import { updateShop, uploadShopLogo } from '@/lib/shops';
import { createTag, deleteTag, listTags, renameTag, updateTagColor } from '@/lib/tags';
import type { Brand, Category, Currency, Product, Profile, Promotion, Shop } from '@/types/models';

const previewCount = 6;
const emptyUsage = new Map<string, number>();
const emptyColors = new Map<string, string | null>();

type SettingsSection = 'profile' | 'shop' | 'catalog' | 'sales';
const sectionOptions: { key: SettingsSection; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'shop', label: 'Shop' },
  { key: 'catalog', label: 'Catalog' },
  { key: 'sales', label: 'Sales' },
];

export default function SettingsScreen() {
  const { shop, profile, session, setProfile, refreshShop } = useAuth();
  const [section, setSection] = useState<SettingsSection>('profile');
  const [brandRows, setBrandRows] = useState<Brand[]>([]);
  const [categoryRows, setCategoryRows] = useState<Category[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string | null>>(emptyColors);
  const [cashiers, setCashiers] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // PromotionsSection's scope picker just needs plain names, same as before
  // this task's state change from string[] to full Brand[]/Category[] rows.
  const brands = useMemo(() => brandRows.map((b) => b.name), [brandRows]);
  const categories = useMemo(() => categoryRows.map((c) => c.name), [categoryRows]);

  const reload = useCallback(async () => {
    if (!shop) return;
    // Not reset to true on subsequent calls -- reload() also runs after every
    // add/rename/delete/color-change, and flipping loading back to true would
    // unmount CategorySection (and close its ManageModal) each time.
    const [brandsResult, categoriesResult, tagsResult, cashiersResult, productsResult, promotionsResult, currenciesResult] =
      await Promise.allSettled([
        listBrands(shop.id),
        listCategories(shop.id),
        listTags(shop.id),
        listCashiers(shop.id),
        listProducts(shop.id),
        listPromotions(shop.id),
        listCurrencies(shop.id),
      ]);
    // Each section is applied independently so one failing query (e.g. a
    // newer, unrelated one like promotions/currencies) can't blank out
    // sections whose own fetch actually succeeded.
    if (brandsResult.status === 'fulfilled') setBrandRows(brandsResult.value);
    if (categoriesResult.status === 'fulfilled') setCategoryRows(categoriesResult.value);
    if (tagsResult.status === 'fulfilled') {
      setTags(tagsResult.value.map((t) => t.name));
      setTagColors(new Map(tagsResult.value.map((t) => [t.name, t.color])));
    }
    if (cashiersResult.status === 'fulfilled') setCashiers(cashiersResult.value.map((c) => c.name));
    if (productsResult.status === 'fulfilled') setProducts(productsResult.value);
    if (promotionsResult.status === 'fulfilled') setPromotions(promotionsResult.value);
    if (currenciesResult.status === 'fulfilled') setCurrencies(currenciesResult.value);

    const firstRejected = [brandsResult, categoriesResult, tagsResult, cashiersResult, productsResult, promotionsResult, currenciesResult].find(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );
    setError(firstRejected ? (firstRejected.reason instanceof Error ? firstRejected.reason.message : 'Could not load some settings data.') : null);
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const brandUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) if (p.brand) counts.set(p.brand, (counts.get(p.brand) ?? 0) + 1);
    return counts;
  }, [products]);

  const categoryUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return counts;
  }, [products]);

  const tagUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) for (const tag of p.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return counts;
  }, [products]);

  const runOrShowError = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  if (!shop) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Settings" />
      <View style={styles.sectionNav}>
        <SegmentedControl options={sectionOptions} value={section} onChange={setSection} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {error && <Text style={styles.error}>{error}</Text>}

        {section === 'profile' && profile && (
          <ProfileSection profile={profile} email={session?.user.email ?? null} onSaved={setProfile} />
        )}
        {section === 'shop' && <ShopSection shop={shop} onSaved={refreshShop} />}

        {(section === 'catalog' || section === 'sales') && loading && <Text style={styles.hint}>Loading…</Text>}

        {section === 'sales' && !loading && (
          <>
            <PromotionsSection
              shopId={shop.id}
              promotions={promotions}
              brands={brands}
              categories={categories}
              onChange={reload}
            />
            <TaxSection shop={shop} onSaved={refreshShop} />
            <CurrenciesSection shopId={shop.id} currencies={currencies} onChange={reload} />
            <CategorySection
              title="CASHIERS"
              itemLabel="cashier"
              hint="Who can be picked as the cashier at checkout in the POS. Shown on the receipt as “Served by”. Renaming or removing one only affects future sales — past receipts keep the name as it was at the time."
              items={cashiers}
              usage={emptyUsage}
              showUsage={false}
              onAdd={(name) => runOrShowError(async () => { await createCashier(shop.id, name); await reload(); })}
              onRename={(oldName, newName) => runOrShowError(async () => { await renameCashier(shop.id, oldName, newName); await reload(); })}
              onDelete={(name) => runOrShowError(async () => { await deleteCashier(shop.id, name); await reload(); })}
            />
          </>
        )}

        {section === 'catalog' && !loading && (
          <>
            <TaxonomySection
              title="BRANDS"
              itemLabel="brand"
              hint="Brands you carry. Renaming or removing a brand updates every product using it."
              items={brandRows}
              usage={brandUsage}
              onCreate={async (input) => { await createBrand(shop.id, input.name, input); await reload(); }}
              onUpdate={async (item, input) => {
                if (input.name !== item.name) await renameBrand(shop.id, item.name, input.name);
                await updateBrand(shop.id, input.name, { color: input.color, description: input.description, imageUrl: input.imageUrl });
                await reload();
              }}
              onDelete={async (item) => { await deleteBrand(shop.id, item.name); await reload(); }}
              uploadImage={(localUri) => uploadBrandImage(shop.id, localUri)}
            />
            <TaxonomySection
              title="CATEGORIES"
              itemLabel="category"
              hint="Group products in the POS and inventory screens. Renaming or removing a category updates every product using it."
              items={categoryRows}
              usage={categoryUsage}
              onCreate={async (input) => { await createCategory(shop.id, input.name, input); await reload(); }}
              onUpdate={async (item, input) => {
                if (input.name !== item.name) await renameCategory(shop.id, item.name, input.name);
                await updateCategory(shop.id, input.name, { color: input.color, description: input.description, imageUrl: input.imageUrl });
                await reload();
              }}
              onDelete={async (item) => { await deleteCategory(shop.id, item.name); await reload(); }}
              uploadImage={(localUri) => uploadCategoryImage(shop.id, localUri)}
            />
            <CategorySection
              title="TAGS"
              itemLabel="tag"
              hint="Extra keywords for products, like bestseller or handmade."
              items={tags}
              usage={tagUsage}
              colors={tagColors}
              onAdd={(name) => runOrShowError(async () => { await createTag(shop.id, name, nextTaxonomyColor(tags.length)); await reload(); })}
              onRename={(oldName, newName) => runOrShowError(async () => { await renameTag(shop.id, oldName, newName); await reload(); })}
              onDelete={(name) => runOrShowError(async () => { await deleteTag(shop.id, name); await reload(); })}
              onColorChange={(name, color) => runOrShowError(async () => { await updateTagColor(shop.id, name, color); await reload(); })}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// Header + preview chips + "View/Update" button, same markup as
// CategorySection (below), but opens TaxonomyManageModal (photo/description
// support) instead of ManageModal — used for Brands/Categories only. Tags
// and Cashiers keep using CategorySection/ManageModal directly.
function TaxonomySection({
  title,
  itemLabel,
  hint,
  items,
  usage,
  onCreate,
  onUpdate,
  onDelete,
  uploadImage,
}: {
  title: string;
  itemLabel: string;
  hint: string;
  items: TaxonomyRow[];
  usage: Map<string, number>;
  onCreate: (input: TaxonomyInput) => Promise<void>;
  onUpdate: (item: TaxonomyRow, input: TaxonomyInput) => Promise<void>;
  onDelete: (item: TaxonomyRow) => Promise<void>;
  uploadImage: (localUri: string) => Promise<string>;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  const mostUsed = useMemo(
    () => [...items].sort((a, b) => (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0)).slice(0, previewCount),
    [items, usage]
  );

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.hint}>{hint}</Text>
        </View>
        <Pressable onPress={() => setModalOpen(true)} style={styles.manageButton}>
          <Text style={styles.manageButtonText}>View/Update ({items.length})</Text>
        </Pressable>
      </View>

      {items.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.previewRow}>
          {mostUsed.map((item) => (
            <View key={item.id} style={styles.previewChip}>
              {item.color && <View style={[styles.previewDot, { backgroundColor: item.color }]} />}
              <Text style={styles.previewChipText}>{item.name}</Text>
              <Text style={styles.previewChipCount}>{usage.get(item.name) ?? 0}</Text>
            </View>
          ))}
          {items.length > previewCount && <Text style={styles.previewMore}>+{items.length - previewCount} more</Text>}
        </View>
      )}

      <TaxonomyManageModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        title={title}
        itemLabel={itemLabel}
        items={items}
        usage={usage}
        nextColor={nextTaxonomyColor(items.length)}
        onCreate={onCreate}
        onUpdate={onUpdate}
        onDelete={onDelete}
        uploadImage={uploadImage}
      />
    </View>
  );
}

function ProfileSection({ profile, email, onSaved }: { profile: Profile; email: string | null; onSaved: (profile: Profile) => void }) {
  const [fullName, setFullName] = useState(profile.fullName ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = fullName.trim() !== (profile.fullName ?? '') || phone.trim() !== (profile.phone ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProfile(profile.id, { fullName: fullName.trim(), phone: phone.trim() });
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>YOUR PROFILE</Text>
      <Text style={styles.hint}>Your name and phone number.</Text>
      {email && (
        <>
          <Text style={styles.fieldLabel}>EMAIL</Text>
          <View style={styles.readOnlyField}>
            <Text style={styles.readOnlyFieldText}>{email}</Text>
          </View>
        </>
      )}
      <View style={styles.formRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>FULL NAME</Text>
          <TextInput value={fullName} onChangeText={setFullName} placeholder="Full name" placeholderTextColor="#999999" style={styles.input} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>PHONE</Text>
          <TextInput value={phone} onChangeText={setPhone} placeholder="Phone number" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.input} />
        </View>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={save} disabled={!dirty || saving} style={[styles.saveButton, (!dirty || saving) && styles.saveButtonDisabled]}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</Text>
      </Pressable>
    </View>
  );
}

function ShopSection({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(shop.name ?? '');
  const [contactPhone, setContactPhone] = useState(shop.contactPhone ?? '');
  const [city, setCity] = useState(shop.city ?? '');
  const [neighborhood, setNeighborhood] = useState(shop.neighborhood ?? '');
  const [description, setDescription] = useState(shop.description ?? '');
  const [returnPolicy, setReturnPolicy] = useState(shop.returnPolicy ?? '');
  const shopGoalInput = shop.monthlyRevenueGoalCents != null ? String(shop.monthlyRevenueGoalCents / 100) : '';
  const [goalInput, setGoalInput] = useState(shopGoalInput);
  const [logoUri, setLogoUri] = useState<string | null>(shop.logoUrl);
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
    logoUri !== shop.logoUrl;

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
      // A freshly picked logo is a local URI, not the http(s) URL of an
      // already-uploaded one — see product-form.tsx for the same check.
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
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>SHOP</Text>
      <Text style={styles.hint}>Shown to customers and used across the app — name, city, neighborhood, and contact phone also appear on printed/shared receipts.</Text>
      <Text style={styles.fieldLabel}>LOGO</Text>
      <View style={styles.logoRow}>
        <Pressable onPress={pickLogo} style={styles.logoPicker}>
          {logoUri ? <Image source={{ uri: logoUri }} contentFit="cover" style={styles.logoPreview} /> : <Text style={styles.logoHint}>Add logo</Text>}
        </Pressable>
        {logoUri && (
          <Pressable onPress={() => setLogoUri(null)}>
            <Text style={styles.logoRemove}>Remove</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.fieldLabel}>SHOP NAME</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Shop name" placeholderTextColor="#999999" style={styles.input} />
      <Text style={styles.fieldLabel}>DESCRIPTION</Text>
      <TextInput value={description} onChangeText={setDescription} placeholder="A short description of your shop" placeholderTextColor="#999999" style={[styles.input, styles.multilineInput]} multiline textAlignVertical="top" />
      <View style={styles.formRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>CITY</Text>
          <TextInput value={city} onChangeText={setCity} placeholder="City" placeholderTextColor="#999999" style={styles.input} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>NEIGHBORHOOD</Text>
          <TextInput value={neighborhood} onChangeText={setNeighborhood} placeholder="Neighborhood or landmark" placeholderTextColor="#999999" style={styles.input} />
        </View>
      </View>
      <Text style={styles.fieldLabel}>CONTACT PHONE</Text>
      <TextInput value={contactPhone} onChangeText={setContactPhone} placeholder="Phone number" placeholderTextColor="#999999" keyboardType="phone-pad" style={styles.input} />
      <Text style={styles.fieldLabel}>RETURN POLICY</Text>
      <TextInput
        value={returnPolicy}
        onChangeText={setReturnPolicy}
        placeholder="e.g. Returns accepted within 7 days with receipt."
        placeholderTextColor="#999999"
        style={[styles.input, styles.multilineInput]}
        multiline
        textAlignVertical="top"
      />
      <Text style={styles.hint}>Printed at the bottom of every receipt.</Text>
      <Text style={styles.fieldLabel}>MONTHLY REVENUE GOAL</Text>
      <TextInput
        value={goalInput}
        onChangeText={setGoalInput}
        placeholder="e.g. 5000"
        placeholderTextColor="#999999"
        keyboardType="decimal-pad"
        style={styles.input}
      />
      <Text style={styles.hint}>Shown as a progress meter on the dashboard. Leave blank to hide it.</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={save} disabled={!dirty || saving} style={[styles.saveButton, (!dirty || saving) && styles.saveButtonDisabled]}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</Text>
      </Pressable>
    </View>
  );
}

function TaxSection({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [taxEnabled, setTaxEnabled] = useState(shop.taxEnabled);
  const [taxRateInput, setTaxRateInput] = useState(String(shop.taxRatePercent));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = taxEnabled !== shop.taxEnabled || taxRateInput.trim() !== String(shop.taxRatePercent);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, { taxEnabled, taxRatePercent: Number(taxRateInput) || 0 });
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
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>TAX</Text>
      <Text style={styles.hint}>When enabled, this rate is added to every sale total, on top of any discounts.</Text>
      <View style={styles.taxRow}>
        <Pressable onPress={() => setTaxEnabled((v) => !v)} style={[styles.taxToggle, taxEnabled && styles.taxToggleOn]}>
          <Text style={[styles.taxToggleText, taxEnabled && styles.taxToggleTextOn]}>{taxEnabled ? 'Enabled' : 'Disabled'}</Text>
        </Pressable>
        {taxEnabled && (
          <View style={styles.taxRateInputWrap}>
            <TextInput value={taxRateInput} onChangeText={setTaxRateInput} placeholder="2.5" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.taxRateInput} />
            <Text style={styles.taxRatePercentSign}>%</Text>
          </View>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={save} disabled={!dirty || saving} style={[styles.saveButton, (!dirty || saving) && styles.saveButtonDisabled]}>
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}</Text>
      </Pressable>
    </View>
  );
}

function CategorySection({
  title,
  itemLabel,
  hint,
  items,
  usage,
  colors = emptyColors,
  showUsage = true,
  onAdd,
  onRename,
  onDelete,
  onColorChange,
}: {
  title: string;
  itemLabel: string;
  hint: string;
  items: string[];
  usage: Map<string, number>;
  colors?: Map<string, string | null>;
  showUsage?: boolean;
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
  onColorChange?: (name: string, color: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  const mostUsed = useMemo(
    () => [...items].sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0)).slice(0, previewCount),
    [items, usage]
  );

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.hint}>{hint}</Text>
        </View>
        <Pressable onPress={() => setModalOpen(true)} style={styles.manageButton}>
          <Text style={styles.manageButtonText}>View/Update ({items.length})</Text>
        </Pressable>
      </View>

      {items.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.previewRow}>
          {mostUsed.map((item) => (
            <View key={item} style={styles.previewChip}>
              {colors.get(item) && <View style={[styles.previewDot, { backgroundColor: colors.get(item) as string }]} />}
              <Text style={styles.previewChipText}>{item}</Text>
              {showUsage && <Text style={styles.previewChipCount}>{usage.get(item) ?? 0}</Text>}
            </View>
          ))}
          {items.length > previewCount && <Text style={styles.previewMore}>+{items.length - previewCount} more</Text>}
        </View>
      )}

      <ManageModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        title={title}
        itemLabel={itemLabel}
        items={items}
        usage={usage}
        colors={colors}
        showUsage={showUsage}
        onAdd={onAdd}
        onRename={onRename}
        onDelete={onDelete}
        onColorChange={onColorChange}
      />
    </View>
  );
}

function ManageModal({
  visible,
  onClose,
  title,
  itemLabel,
  items,
  usage,
  colors = emptyColors,
  showUsage = true,
  onAdd,
  onRename,
  onDelete,
  onColorChange,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  itemLabel: string;
  items: string[];
  usage: Map<string, number>;
  colors?: Map<string, string | null>;
  showUsage?: boolean;
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
  onColorChange?: (name: string, color: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pickingColorFor, setPickingColorFor] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...items].sort((a, b) => (usage.get(b) ?? 0) - (usage.get(a) ?? 0));
    return q ? sorted.filter((item) => item.toLowerCase().includes(q)) : sorted;
  }, [items, usage, search]);

  const submitAdd = () => {
    const trimmed = newValue.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setNewValue('');
  };

  const startEdit = (name: string) => { setEditing(name); setEditValue(name); setConfirmingDelete(null); };
  const submitEdit = () => {
    const trimmed = editValue.trim();
    if (editing !== null && trimmed && trimmed !== editing) onRename(editing, trimmed);
    setEditing(null);
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.modalClose, pressed && styles.modalClosePressed]}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>

          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={`Search ${title.toLowerCase()}…`}
            placeholderTextColor="#999999"
            style={styles.modalSearch}
          />

          <ScrollView style={styles.modalList}>
            {filtered.length === 0 && <Text style={styles.empty}>{search ? 'No matches.' : 'None yet — add one below.'}</Text>}
            {filtered.map((item) => (
              <View key={item}>
                <View style={styles.row}>
                  {editing === item ? (
                    <>
                      <TextInput value={editValue} onChangeText={setEditValue} autoFocus style={styles.editInput} onSubmitEditing={submitEdit} />
                      <Pressable onPress={submitEdit} style={styles.rowAction}><Text style={styles.rowActionText}>Save</Text></Pressable>
                      <Pressable onPress={() => setEditing(null)} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel</Text></Pressable>
                    </>
                  ) : confirmingDelete === item ? (
                    <>
                      <Text style={[styles.rowLabel, { flex: 1 }]}>Delete &quot;{item}&quot;?</Text>
                      <Pressable onPress={() => { onDelete(item); setConfirmingDelete(null); }} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Confirm</Text></Pressable>
                      <Pressable onPress={() => setConfirmingDelete(null)} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel</Text></Pressable>
                    </>
                  ) : (
                    <>
                      {onColorChange && (
                        <Pressable onPress={() => setPickingColorFor((current) => (current === item ? null : item))} style={[styles.colorDot, { backgroundColor: colors.get(item) ?? '#DDDDDD' }]} />
                      )}
                      <Text style={styles.rowLabel}>{item}</Text>
                      {showUsage && <Text style={styles.rowCount}>{usage.get(item) ?? 0}</Text>}
                      <Pressable onPress={() => startEdit(item)} style={styles.rowAction}><Text style={styles.rowActionText}>Rename</Text></Pressable>
                      <Pressable onPress={() => setConfirmingDelete(item)} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Delete</Text></Pressable>
                    </>
                  )}
                </View>
                {pickingColorFor === item && (
                  <View style={styles.colorPalette}>
                    {taxonomyPalette.map((color) => (
                      <Pressable
                        key={color}
                        onPress={() => { onColorChange?.(item, color); setPickingColorFor(null); }}
                        style={[styles.colorSwatch, { backgroundColor: color }, colors.get(item) === color && styles.colorSwatchSelected]}
                      />
                    ))}
                  </View>
                )}
              </View>
            ))}

            <View style={styles.addRow}>
              <TextInput value={newValue} onChangeText={setNewValue} placeholder={`Add a ${itemLabel}…`} placeholderTextColor="#999999" style={styles.addInput} onSubmitEditing={submitAdd} />
              <Pressable onPress={submitAdd} style={styles.addButton}><Text style={styles.addButtonText}>Add</Text></Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function discountLabel(p: Promotion): string {
  return p.discountType === 'percentage' ? `${p.discountValue}% off` : `${formatCents(p.discountValue)} off`;
}

function scopeLabel(p: Promotion): string {
  if (p.scope === 'store') return 'Entire store';
  if (p.scope === 'brand') return `Brand · ${p.scopeValue}`;
  return `Category · ${p.scopeValue}`;
}

function PromotionsSection({
  shopId,
  promotions,
  brands,
  categories,
  onChange,
}: {
  shopId: string;
  promotions: Promotion[];
  brands: string[];
  categories: string[];
  onChange: () => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const preview = promotions.slice(0, previewCount);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>SALES & PROMOTIONS</Text>
          <Text style={styles.hint}>Discounts that apply automatically at checkout — for the whole store, a brand, or a category. The cashier can still override with a manual discount per item.</Text>
        </View>
        <Pressable onPress={() => setModalOpen(true)} style={styles.manageButton}>
          <Text style={styles.manageButtonText}>Manage ({promotions.length})</Text>
        </Pressable>
      </View>

      {promotions.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.previewRow}>
          {preview.map((promo) => (
            <View key={promo.id} style={[styles.previewChip, !promo.active && styles.previewChipInactive]}>
              <Text style={styles.previewChipText}>{promo.name}</Text>
              <Text style={styles.previewChipCount}>{discountLabel(promo)}</Text>
            </View>
          ))}
          {promotions.length > previewCount && <Text style={styles.previewMore}>+{promotions.length - previewCount} more</Text>}
        </View>
      )}

      <PromotionsModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        shopId={shopId}
        promotions={promotions}
        brands={brands}
        categories={categories}
        onChange={onChange}
      />
    </View>
  );
}

function PromotionsModal({
  visible,
  onClose,
  shopId,
  promotions,
  brands,
  categories,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  shopId: string;
  promotions: Promotion[];
  brands: string[];
  categories: string[];
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [scope, setScope] = useState<'store' | 'brand' | 'category'>('store');
  const [scopeValue, setScopeValue] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDiscountType('percentage');
    setDiscountValue('');
    setScope('store');
    setScopeValue(null);
  };

  const startEdit = (promo: Promotion) => {
    setEditingId(promo.id);
    setName(promo.name);
    setDiscountType(promo.discountType);
    setDiscountValue(promo.discountType === 'fixed' ? (promo.discountValue / 100).toFixed(2) : String(promo.discountValue));
    setScope(promo.scope);
    setScopeValue(promo.scopeValue);
    setConfirmingDelete(null);
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const submit = () => {
    const trimmedName = name.trim();
    const num = Number(discountValue);
    if (!trimmedName || !num || num <= 0) return;
    if (scope !== 'store' && !scopeValue) return;
    const input = {
      name: trimmedName,
      discountType,
      discountValue: discountType === 'fixed' ? Math.round(num * 100) : Math.min(num, 100),
      scope,
      scopeValue: scope === 'store' ? null : scopeValue,
      active: true,
    };
    run(async () => {
      if (editingId) await updatePromotion(editingId, input);
      else await createPromotion(shopId, input);
      await onChange();
      resetForm();
    });
  };

  const toggleActive = (promo: Promotion) => run(async () => { await updatePromotion(promo.id, { active: !promo.active }); await onChange(); });

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Sales & promotions</Text>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.modalClose, pressed && styles.modalClosePressed]}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <ScrollView style={styles.modalList}>
            {promotions.length === 0 && <Text style={styles.empty}>None yet — add one below.</Text>}
            {promotions.map((promo) => (
              <View key={promo.id} style={styles.row}>
                {confirmingDelete === promo.id ? (
                  <>
                    <Text style={[styles.rowLabel, { flex: 1 }]}>Delete &quot;{promo.name}&quot;?</Text>
                    <Pressable onPress={() => run(async () => { await deletePromotion(promo.id); await onChange(); setConfirmingDelete(null); })} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(null)} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel</Text></Pressable>
                  </>
                ) : (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowLabel}>{promo.name}</Text>
                      <Text style={styles.rowSubLabel}>{discountLabel(promo)} · {scopeLabel(promo)}</Text>
                    </View>
                    <Pressable onPress={() => toggleActive(promo)} style={styles.rowAction}>
                      <Text style={promo.active ? styles.rowActionText : styles.rowActionTextMuted}>{promo.active ? 'Active' : 'Paused'}</Text>
                    </Pressable>
                    <Pressable onPress={() => startEdit(promo)} style={styles.rowAction}><Text style={styles.rowActionText}>Edit</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(promo.id)} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Delete</Text></Pressable>
                  </>
                )}
              </View>
            ))}

          <View style={styles.promoForm}>
            <Text style={styles.fieldLabel}>{editingId ? 'EDIT SALE' : 'NEW SALE'}</Text>
            <TextInput value={name} onChangeText={setName} placeholder="Sale name, e.g. Summer Sale" placeholderTextColor="#999999" style={styles.addInput} />
            <View style={styles.promoRow}>
              <CategoryChip label="% off" active={discountType === 'percentage'} onPress={() => setDiscountType('percentage')} />
              <CategoryChip label="$ off" active={discountType === 'fixed'} onPress={() => setDiscountType('fixed')} />
              <TextInput
                value={discountValue}
                onChangeText={setDiscountValue}
                placeholder={discountType === 'percentage' ? '10' : '5.00'}
                placeholderTextColor="#999999"
                keyboardType="decimal-pad"
                style={styles.promoValueInput}
              />
            </View>
            <Text style={styles.fieldLabel}>APPLIES TO</Text>
            <View style={styles.promoRow}>
              <CategoryChip label="Entire store" active={scope === 'store'} onPress={() => { setScope('store'); setScopeValue(null); }} />
              <CategoryChip label="A brand" active={scope === 'brand'} onPress={() => { setScope('brand'); setScopeValue(null); }} />
              <CategoryChip label="A category" active={scope === 'category'} onPress={() => { setScope('category'); setScopeValue(null); }} />
            </View>
            {scope === 'brand' && (
              <View style={styles.promoRow}>
                {brands.length === 0 ? (
                  <Text style={styles.empty}>No brands yet — add one above first.</Text>
                ) : (
                  brands.map((b) => <CategoryChip key={b} label={b} active={scopeValue === b} onPress={() => setScopeValue(b)} />)
                )}
              </View>
            )}
            {scope === 'category' && (
              <View style={styles.promoRow}>
                {categories.length === 0 ? (
                  <Text style={styles.empty}>No categories yet — add one above first.</Text>
                ) : (
                  categories.map((c) => <CategoryChip key={c} label={c} active={scopeValue === c} onPress={() => setScopeValue(c)} />)
                )}
              </View>
            )}
            <View style={styles.promoFormActions}>
              {editingId && (
                <Pressable onPress={resetForm} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel edit</Text></Pressable>
              )}
              <Pressable onPress={submit} style={styles.addButton}>
                <Text style={styles.addButtonText}>{editingId ? 'Save changes' : 'Add sale'}</Text>
              </Pressable>
            </View>
          </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function CurrenciesSection({
  shopId,
  currencies,
  onChange,
}: {
  shopId: string;
  currencies: Currency[];
  onChange: () => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const preview = currencies.slice(0, previewCount);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>CURRENCIES</Text>
          <Text style={styles.hint}>Alternate currencies a cashier can accept at checkout, converted to USD by the rate below. Sales are always recorded in USD.</Text>
        </View>
        <Pressable onPress={() => setModalOpen(true)} style={styles.manageButton}>
          <Text style={styles.manageButtonText}>Manage ({currencies.length})</Text>
        </Pressable>
      </View>

      {currencies.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.previewRow}>
          {preview.map((c) => (
            <View key={c.id} style={[styles.previewChip, !c.active && styles.previewChipInactive]}>
              <Text style={styles.previewChipText}>{c.code}</Text>
              <Text style={styles.previewChipCount}>{c.rateToUsd}/$1</Text>
            </View>
          ))}
        </View>
      )}

      <CurrenciesModal visible={modalOpen} onClose={() => setModalOpen(false)} shopId={shopId} currencies={currencies} onChange={onChange} />
    </View>
  );
}

function CurrenciesModal({
  visible,
  onClose,
  shopId,
  currencies,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  shopId: string;
  currencies: Currency[];
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [rateInput, setRateInput] = useState('');

  const resetForm = () => {
    setEditingId(null);
    setCode('');
    setName('');
    setSymbol('');
    setRateInput('');
  };

  const startEdit = (currency: Currency) => {
    setEditingId(currency.id);
    setCode(currency.code);
    setName(currency.name);
    setSymbol(currency.symbol);
    setRateInput(String(currency.rateToUsd));
    setConfirmingDelete(null);
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const submit = () => {
    const trimmedCode = code.trim().toUpperCase();
    const trimmedName = name.trim();
    const trimmedSymbol = symbol.trim();
    const rate = Number(rateInput);
    if (!trimmedName || !trimmedSymbol || !rate || rate <= 0) return;
    run(async () => {
      if (editingId) {
        await updateCurrency(editingId, { name: trimmedName, symbol: trimmedSymbol, rateToUsd: rate });
      } else {
        if (!trimmedCode) return;
        await createCurrency(shopId, { code: trimmedCode, name: trimmedName, symbol: trimmedSymbol, rateToUsd: rate });
      }
      await onChange();
      resetForm();
    });
  };

  const toggleActive = (currency: Currency) => run(async () => { await setCurrencyActive(currency.id, !currency.active); await onChange(); });

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Currencies</Text>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.modalClose, pressed && styles.modalClosePressed]}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <ScrollView style={styles.modalList}>
            {currencies.length === 0 && <Text style={styles.empty}>None yet — add one below.</Text>}
            {currencies.map((currency) => (
              <View key={currency.id} style={styles.row}>
                {confirmingDelete === currency.id ? (
                  <>
                    <Text style={[styles.rowLabel, { flex: 1 }]}>Delete &quot;{currency.code}&quot;?</Text>
                    <Pressable onPress={() => run(async () => { await deleteCurrency(currency.id); await onChange(); setConfirmingDelete(null); })} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(null)} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel</Text></Pressable>
                  </>
                ) : (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowLabel}>{currency.code} · {currency.name}</Text>
                      <Text style={styles.rowSubLabel}>{currency.symbol} · {currency.rateToUsd} per $1</Text>
                    </View>
                    <Pressable onPress={() => toggleActive(currency)} style={styles.rowAction}>
                      <Text style={currency.active ? styles.rowActionText : styles.rowActionTextMuted}>{currency.active ? 'Active' : 'Inactive'}</Text>
                    </Pressable>
                    <Pressable onPress={() => startEdit(currency)} style={styles.rowAction}><Text style={styles.rowActionText}>Edit</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(currency.id)} style={styles.rowAction}><Text style={styles.rowActionTextDanger}>Delete</Text></Pressable>
                  </>
                )}
              </View>
            ))}

          <View style={styles.promoForm}>
            <Text style={styles.fieldLabel}>{editingId ? 'EDIT CURRENCY' : 'NEW CURRENCY'}</Text>
            <View style={styles.formRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>CODE</Text>
                {editingId ? (
                  <View style={styles.readOnlyField}><Text style={styles.readOnlyFieldText}>{code}</Text></View>
                ) : (
                  <TextInput value={code} onChangeText={setCode} placeholder="SLSH" placeholderTextColor="#999999" autoCapitalize="characters" style={styles.input} />
                )}
              </View>
              <View style={{ flex: 2 }}>
                <Text style={styles.fieldLabel}>NAME</Text>
                <TextInput value={name} onChangeText={setName} placeholder="Somaliland Shilling" placeholderTextColor="#999999" style={styles.input} />
              </View>
            </View>
            <View style={styles.formRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>SYMBOL</Text>
                <TextInput value={symbol} onChangeText={setSymbol} placeholder="Sl Sh" placeholderTextColor="#999999" style={styles.input} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>RATE (PER $1)</Text>
                <TextInput value={rateInput} onChangeText={setRateInput} placeholder="115" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.input} />
              </View>
            </View>
            <View style={styles.promoFormActions}>
              {editingId && (
                <Pressable onPress={resetForm} style={styles.rowAction}><Text style={styles.rowActionTextMuted}>Cancel edit</Text></Pressable>
              )}
              <Pressable onPress={submit} style={styles.addButton}>
                <Text style={styles.addButtonText}>{editingId ? 'Save changes' : 'Add currency'}</Text>
              </Pressable>
            </View>
          </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  sectionNav: { paddingHorizontal: 24, paddingTop: 16, maxWidth: 640, width: '100%', alignSelf: 'center' },
  content: { padding: 24, paddingBottom: 60, maxWidth: 640, width: '100%', alignSelf: 'center' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
  section: { marginBottom: 32 },
  formRow: { flexDirection: 'row', gap: 12 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6, marginTop: 10 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  multilineInput: { height: 76, paddingTop: 11 },
  readOnlyField: { backgroundColor: '#F7F7F7', borderRadius: 10, height: 42, paddingHorizontal: 12, justifyContent: 'center' },
  readOnlyFieldText: { color: '#666666', fontSize: 14 },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 6 },
  logoPicker: { width: 64, height: 64, borderRadius: 14, backgroundColor: '#F2F2F2', borderWidth: 1, borderColor: '#EDEDED', borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoPreview: { width: '100%', height: '100%' },
  logoHint: { color: '#999999', fontSize: 10, textAlign: 'center' },
  logoRemove: { color: '#C0392B', fontSize: 12, fontWeight: '700' },
  saveButton: { backgroundColor: '#111111', borderRadius: 10, height: 42, alignItems: 'center', justifyContent: 'center', marginTop: 14, alignSelf: 'flex-start', paddingHorizontal: 22 },
  saveButtonDisabled: { backgroundColor: '#CCCCCC' },
  saveButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#111111', letterSpacing: 0.6, marginBottom: 4 },
  hint: { fontSize: 12, color: '#999999', lineHeight: 17 },
  empty: { fontSize: 13, color: '#999999' },
  manageButton: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 },
  manageButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },

  previewRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  previewChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#F2F2F2', borderRadius: 16, paddingVertical: 7, paddingHorizontal: 12 },
  previewChipInactive: { opacity: 0.45 },
  previewChipText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  previewChipCount: { fontSize: 11, fontWeight: '700', color: '#999999' },
  previewDot: { width: 8, height: 8, borderRadius: 4 },
  colorDot: { width: 16, height: 16, borderRadius: 8 },
  colorPalette: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 8, backgroundColor: '#F2F2F2', borderRadius: 10 },
  colorSwatch: { width: 22, height: 22, borderRadius: 11 },
  colorSwatchSelected: { borderWidth: 2, borderColor: '#111111' },
  previewMore: { fontSize: 12, fontWeight: '600', color: '#999999' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  // `height` (not `maxHeight`) so `modalList` below has a concrete parent
  // size to flex against — a `flex: 1` child inside a `maxHeight`-only,
  // content-sized parent resolves to zero height instead of scrolling (the
  // same Yoga flex-basis pitfall as the POS split panes; see pos.tsx).
  modalCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#111111' },
  modalClose: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  modalClosePressed: { opacity: 0.6 },
  modalCloseText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  modalSearch: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 12, color: '#111111', marginBottom: 12 },
  modalList: { flex: 1, marginBottom: 12 },

  list: { gap: 8, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111', flex: 1 },
  rowSubLabel: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowCount: { fontSize: 12, fontWeight: '700', color: '#999999' },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  rowActionTextMuted: { fontSize: 12, fontWeight: '700', color: '#999999' },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  editInput: { flex: 1, backgroundColor: '#FFFFFF', borderRadius: 8, height: 34, paddingHorizontal: 10, color: '#111111', fontSize: 13 },
  addRow: { flexDirection: 'row', gap: 8 },
  addInput: { flex: 1, backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },

  promoForm: { borderTopWidth: 1, borderTopColor: '#ECECEC', paddingTop: 14, gap: 8 },
  promoRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  promoValueInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111', minWidth: 90 },
  promoFormActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 4 },

  taxRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  taxToggle: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 16 },
  taxToggleOn: { backgroundColor: '#111111' },
  taxToggleText: { fontSize: 12, fontWeight: '700', color: '#999999' },
  taxToggleTextOn: { color: '#FFFFFF' },
  taxRateInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, gap: 4 },
  taxRateInput: { width: 50, color: '#111111', fontSize: 14 },
  taxRatePercentSign: { color: '#999999', fontSize: 14, fontWeight: '700' },
});
