import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/badge';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import type { Module } from '@/lib/entitlements';
import { primaryLocationOf } from '@/lib/location-selection';
import type { Permission } from '@/lib/permissions';
import { countOrdersNeedingAction } from '@/lib/storefront-admin';

export type SettingsNavId =
  | 'profile'
  | 'security'
  | 'billing'
  | 'notifications'
  | 'business'
  | 'locations'
  | 'roles'
  | 'vendors'
  | 'receipt'
  | 'catalog'
  | 'inventory'
  | 'promotions'
  | 'storefront'
  | 'orders'
  | 'payments'
  | 'tax'
  | 'loyalty'
  | 'cashiers'
  | 'registers';

// Listed rather than derived from SETTINGS_NAV: this guard validates a value
// arriving from a URL, and it should keep working if the sidebar is ever
// filtered by permission or reordered.
const SETTINGS_NAV_IDS: SettingsNavId[] = [
  'profile', 'security', 'billing', 'notifications', 'business', 'locations',
  'roles', 'vendors', 'receipt', 'catalog', 'inventory', 'promotions',
  'payments', 'tax', 'loyalty', 'cashiers', 'registers', 'storefront', 'orders',
];

export function isSettingsNavId(value: unknown): value is SettingsNavId {
  return typeof value === 'string' && (SETTINGS_NAV_IDS as string[]).includes(value);
}

// `module` sits beside `permission` because the two gates are orthogonal and
// both must pass: a permission answers "may this user", a module answers "has
// this shop paid for it". An entry that routes somewhere module-gated needs
// both, or it becomes a door onto a screen the reader is bounced off.
type NavItem = { id: SettingsNavId; label: string; icon: keyof typeof Ionicons.glyphMap; permission?: Permission; module?: Module };
type NavGroup = { group: string; items: NavItem[] };

// "Notifications" is hidden — no push/email/WhatsApp send infrastructure
// exists yet, see docs/backlog/2026-08-01-notification-delivery.md. Re-add the
// nav item below (and the 'notifications' case in settings.tsx) once that's
// built.
//
// The Business/Store locations split: "Business" is what the company IS (name,
// logo, return policy, tax, goals) and there is exactly one of it; "Store
// locations" is each place it trades from, each with its own store name,
// address, phone and hours. Everything that varies per place lives on the
// location — which is why sales, stock and shifts point at one.
export const SETTINGS_NAV: NavGroup[] = [
  {
    group: 'Account',
    items: [
      { id: 'profile', label: 'Profile', icon: 'person-outline' },
      { id: 'security', label: 'Security', icon: 'lock-closed-outline' },
      // Deliberately ungated by permission, and deliberately not under a
      // module: this is the one screen that explains why something else is
      // locked and how to unlock it. Hiding it from a lapsed shop would leave
      // them with failures and no route out of them.
      { id: 'billing', label: 'Plan and billing', icon: 'card-outline' },
      // { id: 'notifications', label: 'Notifications', icon: 'notifications-outline' },
    ],
  },
  {
    group: 'Business',
    items: [
      { id: 'business', label: 'Business', icon: 'business-outline' },
      { id: 'locations', label: 'Store locations', icon: 'storefront-outline' },
      { id: 'roles', label: 'Roles', icon: 'shield-checkmark-outline', permission: 'staff.manage' },
      { id: 'vendors', label: 'Vendors', icon: 'briefcase-outline' },
      { id: 'receipt', label: 'Receipt', icon: 'receipt-outline' },
      { id: 'storefront', label: 'Storefront', icon: 'globe-outline', module: 'storefront' },
      // Beside Storefront on purpose: this is what the page it edits actually
      // produces. Read-only (Task 9) -- Plan 4 owns accepting and fulfilling
      // what shows up here.
      { id: 'orders', label: 'Orders', icon: 'bag-check-outline', module: 'storefront' },
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
      { id: 'promotions', label: 'Promotions', icon: 'pricetags-outline', module: 'promotions' },
      { id: 'payments', label: 'Payments', icon: 'cash-outline' },
      { id: 'tax', label: 'Tax and currencies', icon: 'calculator-outline' },
      { id: 'loyalty', label: 'Loyalty', icon: 'star-outline' },
      { id: 'cashiers', label: 'Cashiers', icon: 'card-outline' },
      // Beside Cashiers on purpose: a cashier is WHO rings a sale up, a register
      // is WHERE from. Both belong to a store, which is why they sit together
      // under Sales rather than under Business.
      { id: 'registers', label: 'Registers', icon: 'browsers-outline' },
    ],
  },
];

function useVisibleNav() {
  const { can, hasModule } = useAuth();
  return SETTINGS_NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => (!item.permission || can(item.permission)) && (!item.module || hasModule(item.module))
    ),
  })).filter((group) => group.items.length > 0);
}

// Task 7: publishing a storefront is retroactively consent to take orders,
// and a shop that never thinks to open this exact row would otherwise never
// find out one arrived. Gated the same way the row itself already is
// (module?: Module on NavItem, above) -- a shop without storefront is never
// even asked.
//
// Refetched on focus rather than polled -- see use-refresh-on-focus.ts's own
// header for why a timer here would cost a shop on data it pays for by the
// megabyte. Nothing here is pushed: another till or another phone that
// changes an order still needs a re-focus of THIS screen to pick it up.
//
// N3: this used to be listOrders(shop.id) -- every order the shop has ever
// placed, every column, nested order_items included -- filtered client-side
// for one integer, on EVERY focus of a screen most shops open several times
// a day. countOrdersNeedingAction does the filtering server-side and returns
// only the count.
function useOrdersNeedingActionBadge(): number {
  const { shop, hasModule } = useAuth();
  const enabled = hasModule('storefront');
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!shop || !enabled) {
      setCount(0);
      return;
    }
    try {
      setCount(await countOrdersNeedingAction(shop.id));
    } catch {
      // A failed count must never break the menu it lives in -- no badge is
      // a better outcome than no menu, the same posture support-unread.ts's
      // own refresh() takes.
      setCount(0);
    }
  }, [shop, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useRefreshOnFocus(refresh);

  return count;
}

// Persistent left sidebar, shown at >= TABLET_BREAKPOINT — mirrors
// AdminSidebar's visual language (220px, white, right border, focused state
// = light fill + left border + bold text) so Settings feels like the same
// surface as the rest of the admin shell.
export function SettingsSidebar({ active, onSelect }: { active: SettingsNavId; onSelect: (id: SettingsNavId) => void }) {
  const { shop, locations } = useAuth();
  // The address shown under the shop name is the primary branch's -- the shop
  // itself has none (migration 20260811000000).
  const primaryLocation = primaryLocationOf(locations);
  const groups = useVisibleNav();
  const ordersBadge = useOrdersNeedingActionBadge();

  return (
    <View style={styles.sidebar}>
      <View style={styles.header}>
        <Text style={styles.storeName} numberOfLines={1}>
          {shop?.name ?? 'Your store'}
        </Text>
        {primaryLocation?.city ? (
          <Text style={styles.storeSubtitle} numberOfLines={1}>
            {[primaryLocation.city, primaryLocation.neighborhood].filter(Boolean).join(' · ')}
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
                  {item.id === 'orders' && ordersBadge > 0 ? (
                    <Badge label={ordersBadge > 9 ? '9+' : String(ordersBadge)} tone="danger" />
                  ) : null}
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
  const ordersBadge = useOrdersNeedingActionBadge();

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
                {item.id === 'orders' && ordersBadge > 0 ? (
                  <Badge label={ordersBadge > 9 ? '9+' : String(ordersBadge)} tone="danger" />
                ) : null}
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
