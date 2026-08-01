import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import type { Permission } from '@/lib/permissions';

export type SettingsNavId =
  | 'profile'
  | 'security'
  | 'notifications'
  | 'store'
  | 'staff'
  | 'receipt'
  | 'locations'
  | 'catalog'
  | 'inventory'
  | 'promotions'
  | 'payments'
  | 'tax'
  | 'cashiers';

type NavItem = { id: SettingsNavId; label: string; icon: keyof typeof Ionicons.glyphMap; permission?: Permission };
type NavGroup = { group: string; items: NavItem[] };

// Phase 1 covers profile/store/staff/catalog/promotions/tax/cashiers with
// real data; security/notifications/receipt(partial)/locations/inventory/
// payments render as Phase 2 placeholder panels — see settings.tsx.
export const SETTINGS_NAV: NavGroup[] = [
  {
    group: 'Account',
    items: [
      { id: 'profile', label: 'Profile', icon: 'person-outline' },
      { id: 'security', label: 'Security', icon: 'lock-closed-outline' },
      { id: 'notifications', label: 'Notifications', icon: 'notifications-outline' },
    ],
  },
  {
    group: 'Store',
    items: [
      { id: 'store', label: 'Store', icon: 'storefront-outline' },
      { id: 'staff', label: 'Staff and roles', icon: 'people-outline', permission: 'staff.manage' },
      { id: 'receipt', label: 'Receipt', icon: 'receipt-outline' },
      { id: 'locations', label: 'Locations', icon: 'location-outline' },
    ],
  },
  {
    group: 'Catalog',
    items: [
      { id: 'catalog', label: 'Brands and categories', icon: 'pricetag-outline' },
      { id: 'inventory', label: 'Inventory alerts', icon: 'cube-outline' },
    ],
  },
  {
    group: 'Sales',
    items: [
      { id: 'promotions', label: 'Promotions', icon: 'pricetags-outline' },
      { id: 'payments', label: 'Payments', icon: 'cash-outline' },
      { id: 'tax', label: 'Tax and currencies', icon: 'calculator-outline' },
      { id: 'cashiers', label: 'Cashiers', icon: 'card-outline' },
    ],
  },
];

function useVisibleNav() {
  const { can } = useAuth();
  return SETTINGS_NAV.map((group) => ({ ...group, items: group.items.filter((item) => !item.permission || can(item.permission)) })).filter(
    (group) => group.items.length > 0
  );
}

// Persistent left sidebar, shown at >= TABLET_BREAKPOINT — mirrors
// AdminSidebar's visual language (220px, white, right border, focused state
// = light fill + left border + bold text) so Settings feels like the same
// surface as the rest of the admin shell.
export function SettingsSidebar({ active, onSelect }: { active: SettingsNavId; onSelect: (id: SettingsNavId) => void }) {
  const { shop } = useAuth();
  const groups = useVisibleNav();

  return (
    <View style={styles.sidebar}>
      <View style={styles.header}>
        <Text style={styles.storeName} numberOfLines={1}>
          {shop?.name ?? 'Your store'}
        </Text>
        {shop?.city ? (
          <Text style={styles.storeSubtitle} numberOfLines={1}>
            {[shop.city, shop.neighborhood].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
      <ScrollView style={styles.nav} contentContainerStyle={styles.navContent}>
        {groups.map((group) => (
          <View key={group.group}>
            <Text style={styles.groupLabel}>{group.group}</Text>
            {group.items.map((item) => {
              const focused = item.id === active;
              return (
                <Pressable key={item.id} onPress={() => onSelect(item.id)} style={[styles.navButton, focused && styles.navButtonFocused]}>
                  <Ionicons name={item.icon} size={17} color={focused ? '#111111' : '#6B7280'} />
                  <Text style={[styles.navText, focused && styles.navTextFocused]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// Full-screen grouped list for phone widths — same items, tap to drill into
// the panel (settings.tsx swaps this out for the panel + a back row).
export function SettingsNavList({ onSelect }: { onSelect: (id: SettingsNavId) => void }) {
  const groups = useVisibleNav();

  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      {groups.map((group) => (
        <View key={group.group} style={styles.listGroup}>
          <Text style={styles.groupLabel}>{group.group}</Text>
          <View style={styles.listCard}>
            {group.items.map((item, index) => (
              <Pressable key={item.id} onPress={() => onSelect(item.id)} style={[styles.listRow, index > 0 && styles.listRowBorder]}>
                <Ionicons name={item.icon} size={19} color="#374151" />
                <Text style={styles.listRowText}>{item.label}</Text>
                <Ionicons name="chevron-forward" size={16} color="#9CA3AF" />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sidebar: { width: 220, flexShrink: 0, backgroundColor: '#FFFFFF', borderRightWidth: 1, borderRightColor: '#ECECEC' },
  header: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  storeName: { fontSize: 15, fontWeight: '800', color: '#111111' },
  storeSubtitle: { fontSize: 11, color: '#9CA3AF', marginTop: 2 },
  nav: { flex: 1 },
  navContent: { paddingVertical: 10 },
  groupLabel: { fontSize: 10, fontWeight: '700', color: '#9CA3AF', letterSpacing: 0.9, textTransform: 'uppercase', paddingHorizontal: 14, paddingTop: 14, paddingBottom: 4 },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  navButtonFocused: { backgroundColor: '#F3F4F6', borderLeftColor: '#111111' },
  navText: { fontSize: 13.5, fontWeight: '500', color: '#6B7280' },
  navTextFocused: { color: '#111111', fontWeight: '700' },

  listContent: { padding: 20, paddingBottom: 60 },
  listGroup: { marginBottom: 22 },
  listCard: { backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6', overflow: 'hidden' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 14 },
  listRowBorder: { borderTopWidth: 1, borderTopColor: '#F3F4F6' },
  listRowText: { flex: 1, fontSize: 14.5, fontWeight: '600', color: '#111111' },
});
