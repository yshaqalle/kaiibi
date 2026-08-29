import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Link, usePathname, useRouter } from 'expo-router';
import { ComponentProps, ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge } from '@/components/badge';
import { LocationSwitcher } from '@/components/location-switcher';
import { SupportBanner } from '@/components/support/support-banner';
import { SupportMenuItem } from '@/components/support/support-menu-item';
import { SupportSheet } from '@/components/support/support-sheet';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useOrdersNeedingActionBadge } from '@/hooks/use-orders-needing-action-badge';
import { useShopLogo } from '@/hooks/use-shop-logo';
import { useStorefrontNavState, type StorefrontNavState } from '@/hooks/use-storefront-nav';
import { signOut } from '@/lib/auth';
import { moduleForPath } from '@/lib/entitlements';
import type { Permission } from '@/lib/permissions';
import { AppModal } from '@/components/ui/app-modal';

// Shared between admin-tabs.tsx (native, tablet width) and
// admin-tabs.web.tsx (web, desktop width) so the wide-layout nav only has
// one implementation to keep in sync. Narrow layouts stay
// platform-specific: native phones keep `NativeTabs`, web mobile keeps its
// own hand-rolled bottom nav.
//
// `permission` is what the route's own guard in (admin)/_layout.tsx checks —
// filtering here keeps the nav from offering a destination that would just
// bounce back.
// People is also the entry point to self-service Team for every active staff
// member, even when their role has no management permissions.
//
// `storefront` is here for the same reason `can` is: Storefront and Orders are
// sold, not merely permitted. Unlike the five paid tabs, though, they are
// sometimes HIDDEN rather than shown with the 🔒, and the line between the two
// is not the plan:
//
//   - A shop that NEVER had a storefront still sees nothing. It is not missing
//     anything it can see, and a row for a page that has never existed is an
//     advert, not navigation.
//   - A shop that HAD one and lapsed sees both rows greyed with the 🔒, like
//     any other paid tab. Hiding them from that shop takes away the only
//     signpost back to paying, and its customers' orders are still waiting
//     behind the Orders row.
//
// useStorefrontNavState() is what tells those two apart -- see its own header
// for why the distinction is a `storefronts` row and not a flag.
type NavVisibility = {
  can: (p: Permission) => boolean;
  canAny: (p: Permission[]) => boolean;
  hasActiveMembership: boolean;
  storefront: StorefrontNavState;
};

// A row's icon is EITHER a drawn PNG from assets/images/tabIcons or an
// Ionicon, because the drawn set covers the original five and nothing else.
// Storefront and Orders have no asset, and borrowing one that exists (a cart
// beside POS's cart, say) would be worse than an outline glyph -- so they use
// the same two Ionicons the settings sidebar already labels them with, which
// is what a shopkeeper who has seen them before will recognise.
type NavIcon = { png: ComponentProps<typeof Image>['source'] } | { ionicon: keyof typeof Ionicons.glyphMap };

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: { png: require('@/assets/images/tabIcons/home.png') }, isVisible: (ctx: NavVisibility) => ctx.can('dashboard.view') },
  { href: '/pos', label: 'POS', icon: { png: require('@/assets/images/tabIcons/cart.png') }, isVisible: (ctx: NavVisibility) => ctx.can('pos.access') },
  { href: '/inventory', label: 'Inventory', icon: { png: require('@/assets/images/tabIcons/grid.png') }, isVisible: (ctx: NavVisibility) => ctx.can('inventory.view') },
  {
    href: '/people',
    label: 'People',
    icon: { png: require('@/assets/images/tabIcons/customers.png') },
    isVisible: (ctx: NavVisibility) => ctx.hasActiveMembership || ctx.canAny(['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view']),
  },
  { href: '/accounting', label: 'Accounting', icon: { png: require('@/assets/images/tabIcons/accounting.png') }, isVisible: (ctx: NavVisibility) => ctx.can('sales.view') },
  // The storefront is a sales channel, and it used to be filed as a
  // preference: Settings -> Business -> Storefront, four taps deep on a phone,
  // between Vendors and Receipt. One shop in eleven had ever published a page.
  // Both rows are gated on `settings.access` because that is exactly what
  // (admin)/_layout.tsx checks for these two routes (permissions.ts) -- the
  // nav must never offer a door that bounces straight back -- and on the
  // `storefront` module, the way the settings sidebar already gates them.
  { href: '/storefront', label: 'Storefront', icon: { ionicon: 'globe-outline' }, isVisible: (ctx: NavVisibility) => ctx.storefront !== 'hidden' },
  // Beside Storefront on purpose: this is what the page it edits produces.
  // Carries the count of orders waiting on the shop -- the badge is the whole
  // reason this row belongs on a nav somebody actually looks at, and it stays
  // on the row when the row is locked.
  { href: '/orders', label: 'Orders', icon: { ionicon: 'bag-check-outline' }, badge: 'orders', isVisible: (ctx: NavVisibility) => ctx.storefront !== 'hidden' },
] as const satisfies readonly { href: string; label: string; icon: NavIcon; badge?: 'orders'; isVisible: (ctx: NavVisibility) => boolean }[];

type NavItem = (typeof navItems)[number];

// Extracted so each row can own its own hover state (react-native-web fires
// onHoverIn/onHoverOut on Pressable; native no-ops these harmlessly) without
// the parent re-rendering the whole nav on every mouse move.
function SidebarNavItem({ item, focused, locked, badgeCount = 0 }: { item: NavItem; focused: boolean; locked?: boolean; badgeCount?: number }) {
  const [hovered, setHovered] = useState(false);
  const tint = focused ? '#111111' : '#777777';
  return (
    <Link href={item.href} asChild>
      <Pressable
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={StyleSheet.flatten([styles.navButton, hovered && !focused && styles.navButtonHovered, focused && styles.navButtonFocused])}
      >
        {/* The drawn assets are tinted images; the two Ionicon rows take the
            same two colours at the same 19px, so a mixed rail still reads as
            one set. */}
        {'png' in item.icon ? (
          <Image source={item.icon.png} style={[styles.navIcon, focused && styles.navIconFocused]} tintColor={tint} />
        ) : (
          <Ionicons name={item.icon.ionicon} size={19} color={tint} style={styles.navIcon} />
        )}
        <Text style={[styles.navText, focused && styles.navTextFocused, locked && styles.navTextLocked]}>{item.label}</Text>
        {/* One trailing slot for both marks, because Orders can now carry both
            at once: a lapsed shop's orders are still waiting on it. This used
            to be two siblings each claiming `marginLeft: 'auto'`, which was
            safe only while no row was ever locked AND badged. */}
        {(badgeCount > 0 || locked) && (
          <View style={styles.navTrailing}>
            {badgeCount > 0 && <Badge label={badgeCount > 9 ? '9+' : String(badgeCount)} tone="danger" />}
            {/* Still navigable: tapping lands on the upgrade wall in
                (admin)/_layout.tsx, which is where the offer belongs. Hiding
                the row instead would mean nobody ever discovers what they'd
                be paying for. */}
            {locked && <Text style={styles.navLock}>🔒</Text>}
          </View>
        )}
      </Pressable>
    </Link>
  );
}

/**
 * The web and tablet shell, at both widths.
 *
 * `compact` used to be a separate return in admin-tabs.web.tsx, and that is
 * precisely what made it a bug: two structurally different trees, each with its
 * own `<Slot />`, so crossing `TABLET_BREAKPOINT` did not reflow the screen --
 * it destroyed it and built another. React keeps a component alive by POSITION,
 * and the routed screen had a different address on each side of the line, so
 * every piece of its state went with the old tree. Dragging a window past 820px
 * (or rotating an iPad in a browser) emptied the search box, took the scanned
 * product's result bar with it, and reset the filter, the sort and the scroll.
 *
 * So there is one tree now, and `children` sits at one address in it: root >
 * slot > children, on both sides. The rail, the bar and the bottom nav change
 * around it -- chrome may be rebuilt freely -- but the screen itself is only
 * ever updated. The root's `flexDirection` flips row to column; that is a style,
 * not a new element.
 *
 * What this canNOT fix, and what `use-inventory-session.ts` is for: switching
 * tabs genuinely changes which route `<Slot />` renders, so the old screen must
 * unmount. No tree shape prevents that.
 */
export function AdminSidebar({
  children,
  compact = false,
  bottomNav = null,
}: {
  children: ReactNode;
  /** Narrow web. The rail collapses into a top header plus the caller's nav. */
  compact?: boolean;
  /**
   * Rendered under the screen when `compact`. Passed in rather than built here
   * because the bottom nav carries its own emoji icon set, sized and spaced for
   * a thumb; the rail's is image assets. Merging the two lists would change how
   * mobile web looks, which this restructure deliberately does not.
   */
  bottomNav?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { shop, can, canAny, myMembership, hasModule } = useAuth();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const subtitle = shop?.categories?.[0];
  const [menuOpen, setMenuOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  // Offer the rows, grey them, or show nothing -- one answer, shared by the
  // rail below and the ☰ menu further down so the two cannot disagree at the
  // same width. It already carries the route guard's `settings.access`.
  const storefront = useStorefrontNavState();
  const visibleNavItems = navItems.filter((item) => item.isVisible({ can, canAny, hasActiveMembership: Boolean(myMembership?.active), storefront }));
  // The same hook the settings sidebar's Orders row uses -- one server-side
  // count, not a second list of orders pulled down to be counted here.
  const ordersBadge = useOrdersNeedingActionBadge();

  // Lets the shop logo be changed straight from the sidebar avatar, not just
  // from Settings — a quick "click your logo to change it" affordance. The
  // flow itself lives in useShopLogo(), shared with the mobile header and the
  // Dashboard's header band so all three crop and upload identically.
  const { editLogo, canEditLogo: canEditShop } = useShopLogo();

  return (
    <View style={compact ? styles.rootCompact : styles.tabs}>
      {/* Child 0: the rail, or nothing in its place. Whichever it is, the slot
          below stays child 1 -- which is the whole point of this shape. */}
      {compact ? null : (
        <View style={styles.sidebar}>
          <View style={styles.header}>
            <Pressable onPress={editLogo} disabled={!canEditShop} style={[styles.avatar, shop?.logoUrl && styles.avatarWithLogo]}>
              {shop?.logoUrl ? <Image source={{ uri: shop.logoUrl }} contentFit="cover" style={styles.avatarImage} /> : <Text style={styles.avatarText}>{initial}</Text>}
            </Pressable>
            <View style={styles.headerText}>
              <Text style={styles.shopName} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
              {subtitle && <Text style={styles.shopSubtitle}>{subtitle}</Text>}
            </View>
          </View>
          <View style={styles.nav}>
            {visibleNavItems.map((item) => {
              const required = moduleForPath(item.href);
              return (
                <SidebarNavItem
                  key={item.href}
                  item={item}
                  focused={pathname === item.href}
                  locked={Boolean(required) && !hasModule(required!)}
                  badgeCount={'badge' in item && item.badge === 'orders' ? ordersBadge : 0}
                />
              );
            })}
          </View>
          <View style={styles.footer}>
            <Text style={styles.poweredBy}>Powered by Ka Iibi</Text>
          </View>
        </View>
      )}
      {/* Child 1, a `View` at both widths, holding `children` at a fixed index.
          Nothing above may change this element's type or position. */}
      <View style={styles.slot}>
        <View style={compact ? styles.mobileHeader : [styles.topBar, { paddingTop: insets.top + 10 }]}>
          {/* Narrow has no rail to carry the shop's identity, so the bar does. */}
          {compact ? (
            <View style={styles.mobileHeaderLeft}>
              <Pressable onPress={editLogo} disabled={!canEditShop} style={[styles.avatarSmall, shop?.logoUrl && styles.avatarWithLogo]}>
                {shop?.logoUrl ? <Image source={{ uri: shop.logoUrl }} contentFit="cover" style={styles.avatarImage} /> : <Text style={styles.avatarText}>{initial}</Text>}
              </Pressable>
              <Text style={styles.shopNameCompact} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
            </View>
          ) : null}
          {/* Sits next to the ☰ rather than in the sidebar header, matching the
              mobile-web and native headers: the two controls that act on the
              whole session belong together, and buried under the shop name the
              switcher read as a label rather than something you operate.
              Renders nothing for a one-location shop, which is most of them. */}
          <View style={styles.barRight}>
            <LocationSwitcher />
            {/* The count rides the BUTTON, not just the row inside the menu.
                A shopkeeper spends the day on POS; the row is only visible to
                someone who has already opened the menu, and the dashboard's
                task count only to someone standing on the dashboard. Neither
                reaches the person at the till, which is the one who has to go
                and pick the order. This is the difference between an order
                inbox and an order notification. */}
            <Pressable onPress={() => setMenuOpen(true)} hitSlop={8} style={styles.menuButton}>
              <Text style={styles.menuIcon}>☰</Text>
              {ordersBadge > 0 ? (
                <View style={styles.menuButtonDot}>
                  <Text style={styles.menuButtonDotText}>{ordersBadge > 9 ? '9+' : String(ordersBadge)}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
        </View>
        {/* Under the top bar, over whatever screen is mounted, and driving the
            same `supportOpen` the ☰ row does. The slot carries its own ground
            rather than inheriting one: this View is transparent and the root
            theme behind it follows the DEVICE colour scheme (src/app/
            _layout.tsx), so a banner left to inherit would sit on white or
            black depending on a setting this shell otherwise ignores. */}
        <View style={styles.bannerSlot}>
          <SupportBanner onOpen={() => setSupportOpen(true)} />
        </View>
        {children}
      </View>
      {/* Child 2: the bottom nav, or nothing. Below the slot, so it cannot
          shift `children`'s index either. */}
      {compact ? bottomNav : null}
      <AppModal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          {/* Under the bar in both worlds: the compact header is a fixed 52
              tall and takes no inset, where the top bar grows with it. */}
          <View style={[styles.menuSheet, { top: compact ? 56 : insets.top + 50 }]}>
            {/* Storefront and Orders live here on a phone, not in the bottom
                bar. The bar is five items across a 390pt screen at flex: 1;
                a seventh would leave each about 55pt with a label truncated
                to "Storefr…", and POS and Inventory are what a shopkeeper
                reaches for all day.
                Here they are ONE tap from ☰ instead of four (☰ → Settings →
                the pane picker → Storefront), which is where they were: filed
                under Settings › Business between Vendors and Receipt. A sales
                channel that takes customer orders is not configuration, and a
                walkthrough at this width is what found it -- of 11 shops on
                the system, 1 had published a page.
                The rail (navItems above) shows them as first-class entries at
                tablet width and up, where there is room. */}
            {/* COMPACT ONLY. The rail already carries both rows at wide width
                (navItems above), and it is the primary nav there -- repeating
                them in this menu made the same two destinations appear twice on
                one screen. On a phone there is no rail, the bottom bar is full
                at five, and this menu is the only place they can live.
                `compact &&` is what keeps #102 true, and it has to keep being
                the ONLY width test in this file: the rail's own visibility and
                this one both read `storefront`, so a locked row cannot appear
                in one and not the other. */}
            {compact && storefront !== 'hidden' && (
              <>
                {/* Still pushed, still locked: /storefront and /orders are
                    module-gated routes (entitlements.ts), so a lapsed shop
                    lands on the upgrade wall rather than a dead tap. */}
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.push('/storefront');
                  }}
                  style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Text style={styles.menuItemIcon}>🌐</Text>
                  <Text style={[styles.menuItemText, storefront === 'locked' && styles.menuItemTextLocked]}>Storefront</Text>
                  {storefront === 'locked' ? <Text style={styles.menuLock}>🔒</Text> : null}
                </Pressable>
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.push('/orders');
                  }}
                  style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Text style={styles.menuItemIcon}>🛍</Text>
                  <Text style={[styles.menuItemText, storefront === 'locked' && styles.menuItemTextLocked]}>Orders</Text>
                  {/* The one signal that a customer is waiting. It was only
                      ever rendered inside the settings sidebar, four taps
                      down -- a count nobody was going to see. It survives a
                      lapse: those orders still have to be picked. */}
                  {ordersBadge > 0 ? (
                    <View style={styles.menuBadgeSlot}>
                      <Badge label={ordersBadge > 9 ? '9+' : String(ordersBadge)} tone="danger" />
                    </View>
                  ) : null}
                  {storefront === 'locked' ? <Text style={[styles.menuLock, ordersBadge > 0 && styles.menuLockAfterBadge]}>🔒</Text> : null}
                </Pressable>
                <View style={styles.menuDivider} />
              </>
            )}
            {canEditShop && (
              <>
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.push('/settings');
                  }}
                  style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Text style={styles.menuItemIcon}>⚙</Text>
                  <Text style={styles.menuItemText}>Settings</Text>
                </Pressable>
                <View style={styles.menuDivider} />
              </>
            )}
            <SupportMenuItem
              onPress={() => {
                setMenuOpen(false);
                setSupportOpen(true);
              }}
            />
            <View style={styles.menuDivider} />
            <Pressable
              onPress={() => {
                setMenuOpen(false);
                signOut().then(() => router.replace('/login'));
              }}
              style={({ pressed }) => [styles.menuItem, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={styles.menuItemText}>Sign out</Text>
            </Pressable>
          </View>
        </Pressable>
      </AppModal>
      {/* A sibling of the menu, not a child of it: the menu closes as this
          opens, and a modal nested inside a dismissed one goes with it. */}
      <SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flex: 1, flexDirection: 'row' },
  // The same root, stacked instead of side by side. A style, deliberately, and
  // not a different element -- see the note on the component.
  rootCompact: { flex: 1, flexDirection: 'column' },
  sidebar: { width: 220, flexShrink: 0, backgroundColor: '#FFFFFF', borderRightWidth: 1, borderRightColor: '#ECECEC', paddingVertical: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 24 },
  // Name + category only; the location switcher moved to the top bar (see the
  // comment on it there).
  headerText: { flex: 1, alignItems: 'flex-start', gap: 4 },
  avatar: { width: 34, height: 34, borderRadius: 9, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // A shop's uploaded logo is usually dark ink on a transparent background
  // (meant to sit on a light surface), so the black fallback swatch above
  // would make a dark-ink logo unreadable against it. Only the no-logo
  // initial keeps the black/white treatment; once there's a real image,
  // give it a neutral light backdrop that works with either ink color.
  avatarWithLogo: { backgroundColor: '#F5F5F2' },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  shopName: { color: '#111111', fontSize: 15, fontWeight: '800', maxWidth: 140 },
  shopSubtitle: { color: '#999999', fontSize: 11, marginTop: 1 },
  nav: { paddingHorizontal: 10, gap: 4 },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  navButtonHovered: { backgroundColor: '#F5F5F2' },
  navButtonFocused: { backgroundColor: '#F2F2F2', borderLeftColor: '#111111' },
  navIcon: { width: 19, height: 19 },
  navIconFocused: {},
  navText: { color: '#555555', fontSize: 14.5, fontWeight: '700' },
  navTextLocked: { color: '#999999' },
  navLock: { fontSize: 11 },
  // The far edge of the row, holding the badge and the lock in that order. A
  // lapsed shop's Orders row wears both.
  navTrailing: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 },
  navTextFocused: { color: '#111111', fontWeight: '800' },
  footer: { marginTop: 'auto', paddingHorizontal: 20, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#ECECEC', gap: 8 },
  poweredBy: { color: '#BBBBBB', fontSize: 10, fontWeight: '700' },
  slot: { flex: 1 },
  // The switcher/☰ pair now sits in `barRight` at both widths, which is where
  // the gap between them lives -- it used to be duplicated in two files.
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#ECECEC', backgroundColor: '#FFFFFF' },
  // The narrow bar: a fixed height rather than a safe-area inset, which is what
  // mobile web has always used -- a browser chrome already sits above it.
  mobileHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#ECECEC', backgroundColor: '#FFFFFF' },
  mobileHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, marginRight: 12 },
  avatarSmall: { width: 26, height: 26, borderRadius: 7, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  shopNameCompact: { color: '#111111', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  // Carries the gap the top bar used to set on itself, so the switcher/☰ pair
  // is spaced identically at both widths.
  barRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  // Horizontal padding matches topBar's, so the banner lines up with the ☰
  // above it. Padding only, and the bar's own margins supply the rest, so this
  // is zero-height on the ordinary day when there is nothing unread.
  bannerSlot: { paddingHorizontal: 16, backgroundColor: Colors.light.bentoSurface },
  // Sits on the corner of the ☰ so it reads at a glance from across a
  // counter. Absolutely positioned so adding it cannot move the button.
  menuButtonDot: {
    position: 'absolute', top: -5, right: -6, minWidth: 18,
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 999,
    backgroundColor: '#B3261E', alignItems: 'center', justifyContent: 'center',
  },
  menuButtonDotText: { fontSize: 10.5, fontWeight: '800', color: '#FFFFFF' },
  menuButton: { paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#F5F5F2' },
  menuIcon: { fontSize: 16, color: '#111111' },
  menuBackdrop: { flex: 1 },
  menuSheet: { position: 'absolute', right: 16, minWidth: 160, borderRadius: 12, borderWidth: 1, borderColor: '#ECECEC', paddingVertical: 6, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  menuItemIcon: { fontSize: 15, color: '#111111' },
  menuItemText: { fontSize: 14, fontWeight: '700', color: '#111111' },
  // The muted step of the bento ramp, solved against this sheet's white
  // ground -- the greyed half of the same 🔒 treatment the rail applies.
  menuItemTextLocked: { color: Colors.light.bentoMuted2 },
  menuLock: { fontSize: 11, marginLeft: 'auto' },
  // When the badge already took the far edge, the lock just trails it.
  menuLockAfterBadge: { marginLeft: 6 },
  menuBadgeSlot: { marginLeft: 'auto' },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#ECECEC' },
});
