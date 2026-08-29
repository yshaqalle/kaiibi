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
import { useStorefrontNavState } from '@/hooks/use-storefront-nav';
import { signOut } from '@/lib/auth';
import { moduleForPath } from '@/lib/entitlements';
import { menuButtonA11yLabel, menuRowA11yLabel } from '@/lib/nav-a11y';
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
// Storefront and Orders are deliberately NOT in this list, at any width. Their
// one home is the ☰ menu further down -- see the long note on it for why, and
// for what that buys. Nothing here is gated on the `storefront` module as a
// result, which is why `NavVisibility` has no field for it.
type NavVisibility = {
  can: (p: Permission) => boolean;
  canAny: (p: Permission[]) => boolean;
  hasActiveMembership: boolean;
};

// Every row in this rail is a drawn PNG from assets/images/tabIcons, which is
// the set the original five have and nothing else does. That is not an
// accident of the icon set: the rail is exactly those five.
type NavIcon = { png: ComponentProps<typeof Image>['source'] };

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
  // Storefront and Orders used to sit here, as first-class rail entries at
  // tablet width and up. They are in the ☰ menu at every width now instead --
  // one home rather than one per width. See the note on that menu.
] as const satisfies readonly { href: string; label: string; icon: NavIcon; isVisible: (ctx: NavVisibility) => boolean }[];

type NavItem = (typeof navItems)[number];

// Extracted so each row can own its own hover state (react-native-web fires
// onHoverIn/onHoverOut on Pressable; native no-ops these harmlessly) without
// the parent re-rendering the whole nav on every mouse move.
function SidebarNavItem({ item, focused, locked }: { item: NavItem; focused: boolean; locked?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const tint = focused ? '#111111' : '#777777';
  return (
    <Link href={item.href} asChild>
      <Pressable
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={StyleSheet.flatten([styles.navButton, hovered && !focused && styles.navButtonHovered, focused && styles.navButtonFocused])}
      >
        <Image source={item.icon.png} style={[styles.navIcon, focused && styles.navIconFocused]} tintColor={tint} />
        <Text style={[styles.navText, focused && styles.navTextFocused, locked && styles.navTextLocked]}>{item.label}</Text>
        {/* No rail row carries a waiting-order count any more -- the only one
            that ever did was Orders, and it lives in the ☰ menu now, where it
            keeps its badge. So the far edge of a rail row holds one thing.
            Still navigable when locked: tapping lands on the upgrade wall that
            `withModuleWall` renders inside the route itself
            (components/module-wall.tsx), which is where the offer belongs.
            Hiding the row instead would mean nobody ever discovers what
            they'd be paying for. */}
        {locked && <Text style={styles.navLock}>🔒</Text>}
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
  // Offer the rows, grey them, or show nothing -- one answer for the ☰ menu
  // further down, which is the only surface that carries them. It already
  // carries the route guard's `settings.access`.
  const storefront = useStorefrontNavState();
  const visibleNavItems = navItems.filter((item) => item.isVisible({ can, canAny, hasActiveMembership: Boolean(myMembership?.active) }));
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
            <Pressable
              onPress={() => setMenuOpen(true)}
              hitSlop={8}
              accessibilityRole="button"
              // The dot is paint; this is what somebody who cannot see it
              // hears, and it carries the real number rather than the clamped
              // "9+". See lib/nav-a11y.ts.
              accessibilityLabel={menuButtonA11yLabel(ordersBadge)}
              style={styles.menuButton}
            >
              <Text style={styles.menuIcon}>☰</Text>
              {ordersBadge > 0 ? (
                <View style={styles.menuButtonDot}>
                  {/* One line, always -- see the note on `menuButtonDot`. */}
                  <Text style={styles.menuButtonDotText} numberOfLines={1}>{ordersBadge > 9 ? '9+' : String(ordersBadge)}</Text>
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
        {/* `accessible={false}` is load-bearing, not tidying. React Native's
            Pressable defaults `accessible` to TRUE (Pressable.js:252), and an
            accessible node is a LEAF to iOS -- so on a TABLET, where
            admin-tabs.tsx renders this very component, the whole sheet was
            exposed as one element labelled "🌐, Storefront, 🛍, Orders, 9+, ⚙,
            Settings, Help and support, Sign out" and no row could be focused or
            activated. The web half was spared, having a DOM node per row, but
            it is the same construct and it now gives its place in the tree up
            on both. The backdrop is a dismiss target and nothing else. */}
        <Pressable accessible={false} style={styles.menuBackdrop} onPress={() => setMenuOpen(false)}>
          {/* Under the bar in both worlds: the compact header is a fixed 52
              tall and takes no inset, where the top bar grows with it.
              `onAccessibilityEscape` because the backdrop is no longer
              focusable, so tap-anywhere-to-close is no longer reachable. */}
          <View onAccessibilityEscape={() => setMenuOpen(false)} style={[styles.menuSheet, { top: compact ? 56 : insets.top + 50 }]}>
            {/* THE ONE HOME for Storefront and Orders, at EVERY width. They
                are not in `navItems` above, so no rail carries them; not in
                the web bottom bar (admin-tabs.web.tsx); and not a NativeTabs
                trigger on a phone (admin-tabs.tsx). This menu is it.

                #102's rule -- each row appears once per SCREEN, never twice --
                still holds, and now holds more strongly. It used to be kept by
                two surfaces each gated to its own width, one width test away
                from putting the same destination on screen twice. There is one
                surface at every width now, so there is no second place a
                duplicate could come from.

                Why the menu rather than a nav proper:
                  - One tap from ☰, where it used to be four (☰ → Settings →
                    the pane picker → Storefront), filed under Settings ›
                    Business between Vendors and Receipt. A sales channel that
                    takes customer orders is not configuration, and a
                    walkthrough at 390px is what found it -- of 11 shops on the
                    system, 1 had published a page.
                  - The bottom bar is already full: five items across a 390pt
                    screen at flex: 1. A seventh would leave each about 55pt
                    with a label truncated to "Storefr…", and POS and Inventory
                    are what a shopkeeper reaches for all day.

                `storefront !== 'hidden'` is the only gate left, and it must
                stay the only one -- there is deliberately no width test here
                any more. It is what tells the two hidden-vs-locked cases
                apart:
                  - A shop that NEVER had a storefront still sees nothing. A
                    row for a page that has never existed is an advert, not
                    navigation.
                  - A shop that HAD one and lapsed sees both rows greyed with
                    the 🔒, like any other paid tab. Hiding them from that shop
                    takes away the only signpost back to paying, and its
                    customers' orders are still waiting behind the Orders row.
                See useStorefrontNavState()'s own header for why that
                distinction is a `storefronts` row and not a flag. */}
            {storefront !== 'hidden' && (
              <>
                {/* Still pushed, still locked: /storefront and /orders are
                    module-gated routes (entitlements.ts), so a lapsed shop
                    lands on the upgrade wall rather than a dead tap. */}
                <Pressable
                  onPress={() => {
                    setMenuOpen(false);
                    router.push('/storefront');
                  }}
                  accessibilityRole="button"
                  // Named in words so the 🌐 below does not become the row's
                  // name, and so the 🔒 is heard rather than only seen.
                  accessibilityLabel={menuRowA11yLabel('Storefront', { locked: storefront === 'locked' })}
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
                  accessibilityRole="button"
                  // Carries both marks the row draws: the waiting count and,
                  // for a lapsed shop, the lock.
                  accessibilityLabel={menuRowA11yLabel('Orders', { waiting: ordersBadge, locked: storefront === 'locked' })}
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
                  accessibilityRole="button"
                  accessibilityLabel={menuRowA11yLabel('Settings')}
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
              accessibilityRole="button"
              accessibilityLabel={menuRowA11yLabel('Sign out')}
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
  // The far edge of the row. One thing at a time now: the only rail row that
  // ever carried a second mark was Orders, and it is in the ☰ menu.
  navLock: { fontSize: 11, marginLeft: 'auto' },
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
  // counter. Absolutely positioned so adding it cannot move the button, and
  // given an EXPLICIT size for the reason it used to lack one.
  //
  // It was `minWidth: 18` plus `paddingHorizontal: 5` and no width, and an
  // absolutely positioned Yoga node with no width is measured against its
  // parent's CONTENT box -- here the ☰ glyph, about 19pt at fontSize 16. After
  // this pill's own 10pt of padding roughly 9pt was left for a string needing
  // about 14, so at ten or more waiting orders the `Text` wrapped and drew "9"
  // stacked above "+". Confirmed on an iPhone, where the twin of this style in
  // admin-tabs.tsx did exactly that; this copy reaches the same engine, because
  // admin-tabs.tsx renders THIS component on every tablet.
  //
  // The label is capped at two characters ("9+"), so a fixed box holds every
  // value it can be asked to draw -- and a fixed box is the one thing the
  // parent cannot argue with.
  menuButtonDot: {
    position: 'absolute', top: -5, right: -6, width: 20, height: 16,
    borderRadius: 999,
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
