import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '@/components/screen-header';
import { BillingPanel } from '@/components/settings/panels/billing-panel';
import { CatalogPanel, InventoryAlertsPanel } from '@/components/settings/panels/catalog-panel';
// NotificationsPanel is unused for now — nav item hidden in settings-sidebar.tsx,
// no send infrastructure exists yet (see docs/backlog/2026-08-01-notification-delivery.md).
// import { NotificationsPanel } from '@/components/settings/panels/notifications-panel';
import { LocationsPanel } from '@/components/settings/panels/locations-panel';
import { RegistersPanel } from '@/components/settings/panels/registers-panel';
import { ProfilePanel } from '@/components/settings/panels/profile-panel';
import { ReceiptPanel } from '@/components/settings/panels/receipt-panel';
import { CashiersPanel, LoyaltyPanel, PaymentsPanel, PromotionsPanel, TaxAndCurrenciesPanel } from '@/components/settings/panels/sales-panel';
import { SecurityPanel } from '@/components/settings/panels/security-panel';
import { RolesPanel } from '@/components/settings/panels/roles-panel';
import { BusinessPanel } from '@/components/settings/panels/business-panel';
import { VendorsPanel } from '@/components/settings/panels/vendors-panel';
import { SETTINGS_NAV, SettingsNavList, SettingsSidebar, type SettingsNavId } from '@/components/settings/settings-sidebar';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import { createBrand, deleteBrand, listBrands, renameBrand, updateBrand, uploadBrandImage } from '@/lib/brands';
import { createCashier, deleteCashier, listCashiers, renameCashier } from '@/lib/cashiers';
import { createCategory, deleteCategory, listCategories, renameCategory, updateCategory, uploadCategoryImage } from '@/lib/categories';
import { nextTaxonomyColor } from '@/lib/colors';
import { listCurrencies } from '@/lib/currencies';
import { listProducts } from '@/lib/products';
import { listPromotions } from '@/lib/promotions';
import { countStaffByRole, listRoles } from '@/lib/staff';
import { createTag, deleteTag, listTags, renameTag, updateTagColor } from '@/lib/tags';
import { listLocations } from '@/lib/locations';
import { listRegisters } from '@/lib/registers';
import { listVendors } from '@/lib/vendors';
import type { Brand, Category, Currency, Product, Promotion, Register, Role, ShopLocation, Vendor } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

export default function SettingsScreen() {
  // Managing stores needs ALL of them, which is wider than `useAuth().locations`
  // -- that is narrowed to the stores this user may operate at (a manager
  // assigned to one store still administers the rest). refreshShop() is still
  // called on save so the header switcher picks the edit up too.
  const { shop, profile, session, setProfile, refreshShop, can } = useAuth();
  const { width } = useWindowDimensions();
  const isWide = width >= TABLET_BREAKPOINT;

  const [activeNav, setActiveNav] = useState<SettingsNavId>('profile');
  const [menuOpen, setMenuOpen] = useState(false);

  const [brandRows, setBrandRows] = useState<Brand[]>([]);
  const [categoryRows, setCategoryRows] = useState<Category[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagColors, setTagColors] = useState<Map<string, string | null>>(new Map());
  const [cashiers, setCashiers] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [allLocations, setAllLocations] = useState<ShopLocation[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [registers, setRegisters] = useState<Register[]>([]);
  const [roleUsage, setRoleUsage] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const brands = useMemo(() => brandRows.map((b) => b.name), [brandRows]);
  const categories = useMemo(() => categoryRows.map((c) => c.name), [categoryRows]);

  const reload = useCallback(async () => {
    if (!shop) return;
    // Not reset to true on subsequent calls -- reload() also runs after every
    // add/rename/delete/color-change, and flipping loading back to true would
    // unmount panels (and close any open modal) each time.
    const [brandsResult, categoriesResult, tagsResult, cashiersResult, productsResult, promotionsResult, currenciesResult, vendorsResult, locationsResult, registersResult] =
      await Promise.allSettled([
        listBrands(shop.id),
        listCategories(shop.id),
        listTags(shop.id),
        listCashiers(shop.id),
        listProducts(shop.id),
        listPromotions(shop.id),
        listCurrencies(shop.id),
        listVendors(shop.id),
        listLocations(shop.id),
        listRegisters(shop.id),
      ]);
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
    if (vendorsResult.status === 'fulfilled') setVendors(vendorsResult.value);
    if (locationsResult.status === 'fulfilled') setAllLocations(locationsResult.value);
    if (registersResult.status === 'fulfilled') setRegisters(registersResult.value);

    const results: PromiseSettledResult<unknown>[] = [
      brandsResult,
      categoriesResult,
      tagsResult,
      cashiersResult,
      productsResult,
      promotionsResult,
      currenciesResult,
      vendorsResult,
      locationsResult,
    ];

    // Roles/staff are only fetched for owners/managers who can actually see
    // the "Staff and roles" panel — RLS would reject these for a cashier
    // account, and that shouldn't surface as a generic Settings load error.
    if (can('staff.manage')) {
      const [rolesResult, roleUsageResult] = await Promise.allSettled([listRoles(shop.id), countStaffByRole(shop.id)]);
      if (rolesResult.status === 'fulfilled') setRoles(rolesResult.value);
      if (roleUsageResult.status === 'fulfilled') setRoleUsage(roleUsageResult.value);
      results.push(rolesResult, roleUsageResult);
    }

    const firstRejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setError(firstRejected ? (firstRejected.reason instanceof Error ? firstRejected.reason.message : 'Could not load some settings data.') : null);
    setLoading(false);
  }, [shop, can]);

  useEffect(() => {
    reload();
  }, [reload]);

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

  const handleSelectNav = (id: SettingsNavId) => {
    setActiveNav(id);
    setMenuOpen(false);
  };

  const activeLabel = SETTINGS_NAV.flatMap((group) => group.items).find((item) => item.id === activeNav)?.label ?? 'Settings';

  const panel = (() => {
    switch (activeNav) {
      case 'profile':
        return profile ? <ProfilePanel profile={profile} email={session?.user.email ?? null} onSaved={setProfile} /> : null;
      case 'billing':
        return <BillingPanel />;
      case 'business':
        return <BusinessPanel shop={shop} onSaved={refreshShop} />;
      case 'locations':
        return <LocationsPanel shopId={shop.id} locations={allLocations} onChange={async () => { await reload(); await refreshShop(); }} />;
      case 'receipt':
        return <ReceiptPanel shop={shop} onSaved={refreshShop} />;
      case 'catalog':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <CatalogPanel
            brandRows={brandRows}
            categoryRows={categoryRows}
            tags={tags}
            tagColors={tagColors}
            brandUsage={brandUsage}
            categoryUsage={categoryUsage}
            tagUsage={tagUsage}
            onCreateBrand={async (input) => {
              if (brandRows.some((b) => b.name.toLowerCase() === input.name.trim().toLowerCase())) {
                throw new Error(`A brand named "${input.name.trim()}" already exists.`);
              }
              await createBrand(shop.id, input.name, input);
              await reload();
            }}
            onUpdateBrand={async (item, input) => {
              if (input.name !== item.name) await renameBrand(shop.id, item.name, input.name);
              await updateBrand(shop.id, input.name, { color: input.color, description: input.description, imageUrl: input.imageUrl });
              await reload();
            }}
            onDeleteBrand={async (item) => {
              await deleteBrand(shop.id, item.name);
              await reload();
            }}
            uploadBrandImage={(localUri) => uploadBrandImage(shop.id, localUri)}
            onCreateCategory={async (input) => {
              if (categoryRows.some((c) => c.name.toLowerCase() === input.name.trim().toLowerCase())) {
                throw new Error(`A category named "${input.name.trim()}" already exists.`);
              }
              await createCategory(shop.id, input.name, input);
              await reload();
            }}
            onUpdateCategory={async (item, input) => {
              if (input.name !== item.name) await renameCategory(shop.id, item.name, input.name);
              await updateCategory(shop.id, input.name, { color: input.color, description: input.description, imageUrl: input.imageUrl });
              await reload();
            }}
            onDeleteCategory={async (item) => {
              await deleteCategory(shop.id, item.name);
              await reload();
            }}
            uploadCategoryImage={(localUri) => uploadCategoryImage(shop.id, localUri)}
            onAddTag={(name) =>
              runOrShowError(async () => {
                await createTag(shop.id, name, nextTaxonomyColor(tags.length));
                await reload();
              })
            }
            onRenameTag={(oldName, newName) =>
              runOrShowError(async () => {
                await renameTag(shop.id, oldName, newName);
                await reload();
              })
            }
            onDeleteTag={(name) =>
              runOrShowError(async () => {
                await deleteTag(shop.id, name);
                await reload();
              })
            }
            onTagColorChange={(name, color) =>
              runOrShowError(async () => {
                await updateTagColor(shop.id, name, color);
                await reload();
              })
            }
          />
        );
      case 'promotions':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <PromotionsPanel shopId={shop.id} promotions={promotions} brands={brands} categories={categories} onChange={reload} />
        );
      case 'tax':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <TaxAndCurrenciesPanel shop={shop} onShopSaved={refreshShop} currencies={currencies} onCurrenciesChange={reload} />
        );
      case 'loyalty':
        return <LoyaltyPanel shop={shop} onSaved={refreshShop} />;
      case 'cashiers':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <CashiersPanel
            shopId={shop.id}
            cashiers={cashiers}
            onAdd={(name) =>
              runOrShowError(async () => {
                await createCashier(shop.id, name);
                await reload();
              })
            }
            onRename={(oldName, newName) =>
              runOrShowError(async () => {
                await renameCashier(shop.id, oldName, newName);
                await reload();
              })
            }
            onDelete={(name) =>
              runOrShowError(async () => {
                await deleteCashier(shop.id, name);
                await reload();
              })
            }
          />
        );
      case 'registers':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <RegistersPanel
            shop={shop}
            registers={registers}
            locations={allLocations}
            onChange={reload}
          />
        );
      case 'security':
        return profile ? <SecurityPanel profile={profile} onProfileSaved={setProfile} /> : null;
      // case 'notifications': hidden for now — see import comment above.
      //   return <NotificationsPanel shop={shop} onSaved={refreshShop} />;
      case 'inventory':
        return <InventoryAlertsPanel shop={shop} onSaved={refreshShop} />;
      case 'payments':
        return <PaymentsPanel shop={shop} onSaved={refreshShop} />;
      case 'roles':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <RolesPanel shopId={shop.id} roles={roles} usage={roleUsage} onChange={reload} />
        );
      case 'vendors':
        return loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <VendorsPanel shopId={shop.id} vendors={vendors} onChange={reload} />
        );
    }
  })();

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Settings" />
      {error && <Text style={styles.error}>{error}</Text>}
      {isWide ? (
        <View style={styles.wideBody}>
          <SettingsSidebar active={activeNav} onSelect={handleSelectNav} />
          <ScrollView contentContainerStyle={styles.content}>{panel}</ScrollView>
        </View>
      ) : (
        <View style={styles.narrowBody}>
          <Pressable onPress={() => setMenuOpen(true)} style={styles.menuBar}>
            <Ionicons name="menu-outline" size={20} color="#111111" />
            <Text style={styles.menuBarText}>{activeLabel}</Text>
            <Ionicons name="chevron-down" size={16} color="#9CA3AF" />
          </Pressable>
          <ScrollView contentContainerStyle={styles.content}>{panel}</ScrollView>
          <AppModal visible={menuOpen} transparent animationType="slide" onRequestClose={() => setMenuOpen(false)}>
            <View style={styles.sheetContainer}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuOpen(false)} />
              <View style={styles.sheet}>
                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetTitle}>Settings</Text>
                  <Pressable onPress={() => setMenuOpen(false)}>
                    <Text style={styles.sheetClose}>Done</Text>
                  </Pressable>
                </View>
                <SettingsNavList onSelect={handleSelectNav} />
              </View>
            </View>
          </AppModal>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  wideBody: { flex: 1, flexDirection: 'row' },
  narrowBody: { flex: 1 },
  content: { padding: 24, paddingBottom: 60 },
  menuBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  menuBarText: { flex: 1, fontSize: 15, fontWeight: '700', color: '#111111' },
  sheetContainer: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { maxHeight: '80%', backgroundColor: '#FFFFFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: '#111111' },
  sheetClose: { fontSize: 14, fontWeight: '700', color: '#111111' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', paddingHorizontal: 24, paddingTop: 16 },
  hint: { fontSize: 13, color: '#9CA3AF' },
});
