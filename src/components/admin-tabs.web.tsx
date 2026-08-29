import { Link, Slot, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { AdminSidebar } from '@/components/admin-sidebar';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { useAuth } from '@/hooks/use-auth';
import { moduleForPath } from '@/lib/entitlements';
import type { Permission } from '@/lib/permissions';

// Bottom nav for narrow/mobile-web only — the wide layout uses the shared
// `AdminSidebar` (see admin-sidebar.tsx), which has its own icon set.
// `permission` mirrors the route guard in (admin)/_layout.tsx, so a role that
// can't open a screen never sees a tab for it.
type NavVisibility = { can: (p: Permission) => boolean; canAny: (p: Permission[]) => boolean; hasActiveMembership: boolean };

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '🏠', isVisible: (ctx: NavVisibility) => ctx.can('dashboard.view') },
  { href: '/pos', label: 'POS', icon: '🛒', isVisible: (ctx: NavVisibility) => ctx.can('pos.access') },
  { href: '/inventory', label: 'Inventory', icon: '▦', isVisible: (ctx: NavVisibility) => ctx.can('inventory.view') },
  {
    href: '/people',
    label: 'People',
    icon: '👥',
    isVisible: (ctx: NavVisibility) => ctx.hasActiveMembership || ctx.canAny(['customers.view', 'staff.manage', 'people.timeoff.approve', 'people.payroll.manage', 'people.timesheet.view']),
  },
  // 🧮 rather than 📈: a rising chart reads as analytics, which is what this
  // tab meant when it was Sales. It now covers bills, expenses, payroll and
  // the P&L — bookkeeping, matching the calculator used by the other two navs.
  { href: '/accounting', label: 'Accounting', icon: '🧮', isVisible: (ctx: NavVisibility) => ctx.can('sales.view') },
  // Storefront and Orders are deliberately NOT here, locked or otherwise.
  // This bar is five items at flex: 1 across a 390pt screen; a seventh leaves
  // each about 55pt with a label truncated to "Storefr…". Their one home is
  // the ☰ menu in admin-sidebar.tsx, which carries them at EVERY width -- the
  // rail this bar replaces does not carry them either. #102's rule is that
  // each row appears once per SCREEN, so a greyed row added here would put
  // the narrow shop's Storefront in two places at once.
] as const satisfies readonly { href: string; label: string; icon: string; isVisible: (ctx: NavVisibility) => boolean }[];

// Below `TABLET_BREAKPOINT` the persistent sidebar would eat more than half
// a phone screen (and leave two-pane screens like POS with almost nothing
// to work with), so it collapses into a slim top header + this bottom tab bar
// instead — the standard mobile-web nav shape.
//
// Both widths render through ONE `AdminSidebar` with one `<Slot />` inside it.
// They used to be two separate returns here, each with a `<Slot />` of its own,
// which meant crossing the breakpoint unmounted the routed screen and threw its
// state away. See the note on `AdminSidebar` for why position is what matters.
export default function AdminTabs() {
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;

  return (
    <AdminSidebar compact={compact} bottomNav={<BottomNav />}>
      <Slot />
    </AdminSidebar>
  );
}

// Narrow only. Kept here, and kept on emoji, because the rail's nav is image
// assets at a different size and spacing — sharing one list between them would
// change how mobile web looks.
function BottomNav() {
  const pathname = usePathname();
  const { can, canAny, myMembership, hasModule } = useAuth();
  const visibleNavItems = navItems.filter((item) => item.isVisible({ can, canAny, hasActiveMembership: Boolean(myMembership?.active) }));

  return (
    <View style={styles.bottomNav}>
      {visibleNavItems.map((item) => {
        const isFocused = pathname === item.href;
        // Locked, not hidden — tapping lands on the upgrade wall, which is
        // where the offer belongs. See admin-sidebar.tsx.
        const required = moduleForPath(item.href);
        const locked = Boolean(required) && !hasModule(required!);
        return (
          <Link key={item.href} href={item.href} asChild>
            <Pressable style={styles.bottomNavItem}>
              <View style={[styles.bottomNavIconWrap, isFocused && styles.bottomNavIconWrapFocused]}>
                <Text style={[styles.bottomNavIcon, isFocused && styles.bottomNavIconFocused]}>{locked ? '🔒' : item.icon}</Text>
              </View>
              <Text
                style={[styles.bottomNavText, isFocused && styles.bottomNavTextFocused, locked && styles.bottomNavTextLocked]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </Pressable>
          </Link>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bottomNav: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#ECECEC', backgroundColor: '#FFFFFF', paddingBottom: 12, paddingTop: 10 },
  bottomNavItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 4 },
  bottomNavIconWrap: { width: 46, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  bottomNavIconWrapFocused: { backgroundColor: '#111111' },
  bottomNavIcon: { fontSize: 18, color: '#999999' },
  bottomNavIconFocused: { color: '#FFFFFF' },
  bottomNavText: { color: '#999999', fontSize: 11.5, fontWeight: '700' },
  bottomNavTextLocked: { color: '#AAAAAA' },
  bottomNavTextFocused: { color: '#111111', fontWeight: '800' },
});
