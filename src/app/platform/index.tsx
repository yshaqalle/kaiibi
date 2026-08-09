import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PlatformOverview } from '@/components/platform-overview';
import { PlatformModal } from '@/components/platform/kit';
import { AuditTab, OperatorsTab } from '@/components/platform/log-tabs';
import { PlansTab } from '@/components/platform/plans-tab';
import { RequestsTab } from '@/components/platform/requests-tab';
import { ShopDrawer } from '@/components/platform/shop-drawer';
import { ShopsTab } from '@/components/platform/shops-tab';
import { TabPills } from '@/components/ui/tab-pills';
import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';
import { webDataAttr } from '@/lib/web-data-attr';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import {
  getPlatformSettings,
  listAuditLog,
  listOperators,
  listPendingPlanRequests,
  listPlatformShops,
  listSubscriptionPayments,
  type PendingPlanRequest,
  type PlatformAuditRow,
  type PlatformOperator,
  type PlatformSettings,
  type PlatformShopRow,
  type SubscriptionPaymentRow,
} from '@/lib/platform';
import { listAllPlans, type Plan } from '@/lib/subscriptions';
import { AppModal } from '@/components/ui/app-modal';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// Kaiibi's operator console, in the bento language.
//
// The sidebar is kept rather than replaced with accounting.tsx's shell
// wholesale: bento is a SURFACE system, and six destinations an operator
// ping-pongs between while working a single shop is what a persistent rail is
// for. What changed is the surfaces — no border down its edge, and the active
// item is now the only white thing in it rather than the only grey one, which
// is why nothing in the old nav read as selected.
//
// Below the breakpoint the rail becomes the horizontal pill row every other
// bento screen uses, and the header row is the accounting recipe exactly:
// eyebrow, 26px title, blurb, controls right.

type Tab = 'overview' | 'shops' | 'requests' | 'plans' | 'audit' | 'operators';

// The blurb says what the tab is FOR. Overview's is computed from the data and
// published up by the tab itself, so the sentence an operator reads first is
// the state of the business rather than a description of the screen.
const TABS: { key: Tab; label: string; blurb: string }[] = [
  { key: 'overview', label: 'Overview', blurb: 'Is the business growing, is money arriving, who needs a conversation today.' },
  { key: 'shops', label: 'Stores', blurb: 'Every business on Kaiibi, what they pay, and what they are using.' },
  { key: 'requests', label: 'Requests', blurb: 'Tier changes waiting on a decision. Approving one moves what a store can do.' },
  { key: 'plans', label: 'Plans', blurb: 'What each tier includes, withholds, and caps — and who is on it.' },
  { key: 'audit', label: 'Audit log', blurb: 'Every operator action, who took it, and why. Append-only.' },
  { key: 'operators', label: 'Operators', blurb: 'Who can reach this portal at all.' },
];

export default function PlatformHome() {
  const [tab, setTab] = useState<Tab>('overview');
  const [shops, setShops] = useState<PlatformShopRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [audit, setAudit] = useState<PlatformAuditRow[]>([]);
  const [operators, setOperators] = useState<PlatformOperator[]>([]);
  const [requests, setRequests] = useState<PendingPlanRequest[]>([]);
  const [payments, setPayments] = useState<SubscriptionPaymentRow[]>([]);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  // When the data on screen was fetched. Passed to the Overview so every
  // figure is measured against one instant, and so nothing reads the clock
  // during render.
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Published by the Overview once it has counted the money. Held here so it
  // can sit in the header beside the title.
  const [headline, setHeadline] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const { session } = useAuth();
  const compact = width < TABLET_BREAKPOINT;

  // Does not re-arm `loading`: the initial value covers the first load, and a
  // refresh after an action should update the table in place rather than
  // replacing the operator's screen with a spinner and losing their scroll
  // position mid-task.
  const reload = useCallback(async () => {
    // Plans and settings first, alone: listPlatformShops needs the plans to
    // resolve a retired plan to its successor, and needs post_trial_plan_key to
    // mirror shop_effective_plan()'s expired/suspended branch -- so neither can
    // run in the same batch as the shops read.
    const [planRows, settingsRow] = await Promise.all([listAllPlans(), getPlatformSettings()]);
    const [shopRows, auditRows, operatorRows, requestRows, paymentRows] = await Promise.all([
      listPlatformShops(planRows, settingsRow.postTrialPlanKey),
      listAuditLog(),
      listOperators(),
      listPendingPlanRequests(),
      listSubscriptionPayments(),
    ]);
    setShops(shopRows);
    setPlans(planRows);
    setAudit(auditRows);
    setOperators(operatorRows);
    setRequests(requestRows);
    setPayments(paymentRows);
    setSettings(settingsRow);
    setLoadedAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selectedShop = shops.find((s) => s.shopId === selected) ?? null;
  const myRole = operators.find((o) => o.userId === session?.user.id)?.role ?? null;
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  const blurb = tab === 'overview' && headline ? headline : current.blurb;

  const body = loading ? (
    <ActivityIndicator style={styles.spinner} />
  ) : tab === 'overview' ? (
    <PlatformOverview
      shops={shops}
      plans={plans}
      payments={payments}
      audit={audit}
      now={loadedAt}
      onHeadline={setHeadline}
      onOpenShop={(id) => {
        setSelected(id);
        setTab('shops');
      }}
    />
  ) : tab === 'shops' ? (
    <ShopsTab shops={shops} plans={plans} compact={compact} selected={selected} onSelect={setSelected} />
  ) : tab === 'requests' ? (
    <RequestsTab requests={requests} shops={shops} onDone={reload} />
  ) : tab === 'plans' ? (
    <PlansTab
      plans={plans}
      shops={shops}
      compact={compact}
      pendingRequestsByPlanKey={requests.reduce<Record<string, number>>(
        (acc, r) => ({ ...acc, [r.planKey]: (acc[r.planKey] ?? 0) + 1 }),
        {}
      )}
      postTrialPlanKey={settings?.postTrialPlanKey ?? 'free'}
      onDone={reload}
    />
  ) : tab === 'audit' ? (
    <AuditTab rows={audit} shops={shops} />
  ) : (
    <OperatorsTab operators={operators} />
  );

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <View style={[styles.root, compact && styles.rootCompact]}>
        {compact ? null : (
          <View style={styles.rail}>
            <Text style={styles.brand}>KAIIBI</Text>
            <Text style={styles.brandSub}>PLATFORM</Text>
            <View style={styles.nav}>
              {TABS.map((option) => {
                const active = option.key === tab;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => setTab(option.key)}
                    style={({ hovered }) => [styles.navItem, active && styles.navItemActive, hovered && !active && styles.navItemHovered]}
                    // Kills the outline a mouse click leaves behind; keyboard
                    // focus keeps its ring. See global.css.
                    {...webDataAttr('pointer-focus-quiet')}
                    role="tab"
                    aria-selected={active}
                  >
                    <Text style={[styles.navText, active && styles.navTextActive]}>{option.label}</Text>
                    {option.key === 'requests' && requests.length > 0 ? (
                      <View style={styles.navCount}>
                        <Text style={styles.navCountText}>{requests.length}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        <ScrollView style={styles.main} contentContainerStyle={compact ? styles.mainContentCompact : styles.mainContent}>
          {compact ? (
            <>
              <View style={styles.mobileBrand}>
                <Text style={styles.brandCompact}>KAIIBI PLATFORM</Text>
              </View>
              <View style={styles.tabBar}>
                <TabPills
                  options={TABS.map((option) => ({
                    key: option.key,
                    label: option.key === 'requests' && requests.length > 0 ? `${option.label} · ${requests.length}` : option.label,
                  }))}
                  value={tab}
                  onChange={setTab}
                />
              </View>
            </>
          ) : null}

          {/* Titles left, the account menu top right — the same header shape
              accounting.tsx uses for its controls. */}
          <View style={styles.header}>
            <View style={styles.headerTitles}>
              <Text style={styles.eyebrow}>PLATFORM</Text>
              <Text style={styles.title}>{current.label}</Text>
              <Text style={styles.blurb}>{blurb}</Text>
            </View>
            <AccountMenu email={session?.user.email ?? null} role={myRole} />
          </View>

          {body}
        </ScrollView>
      </View>

      {/* The detail is always a modal. Inline, it appended itself below a long
          table, so tapping a shop put the answer off-screen and left you
          scrolling to find what you had just clicked. */}
      {selectedShop ? (
        <PlatformModal title={selectedShop.shopName} compact={compact} onClose={() => setSelected(null)}>
          <ShopDrawer shop={selectedShop} plans={plans} onDone={reload} />
        </PlatformModal>
      ) : null}
    </SafeAreaView>
  );
}

// Who is signed in, and the way out.
//
// Behind a menu rather than sitting in the header, because "Sign out" is the
// only thing in it and a permanent red link is a destructive action given
// permanent prominence — it reads as a warning when nothing is wrong. Folding
// it into a menu also stops an arbitrarily long email competing with the tab
// title for the top of the screen.
//
// Worth being able to check at all, though: an operator account is a second
// identity most people also hold a shop login for, and acting on the wrong one
// is the mistake the email in here prevents.
function AccountMenu({ email, role }: { email: string | null; role: string | null }) {
  // The button's position in the window, captured on press. Non-null IS the
  // open state -- the menu cannot be drawn before it knows where to draw, so
  // one piece of state cannot disagree with the other.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<View>(null);
  const { width } = useWindowDimensions();

  // Rendered in a Modal rather than absolutely inside the header.
  //
  // Absolute positioning made it a child of the scrolling content, which
  // clipped it: the card was cut off mid-email at the edge of the header, and
  // `zIndex` cannot help with that -- clipping is an overflow question, not a
  // stacking one. A Modal portals to the root, so nothing on the page can crop
  // it. That costs the anchor, which is why the button is measured first.
  const toggle = () => {
    if (anchor) {
      setAnchor(null);
      return;
    }
    button.current?.measureInWindow((x, y, w, h) => {
      setAnchor({ top: y + h + 8, right: Math.max(12, width - (x + w)) });
    });
  };

  return (
    <>
      <Pressable
        ref={button}
        onPress={toggle}
        style={({ hovered }) => [styles.menuButton, (hovered || anchor) && styles.menuButtonActive]}
        hitSlop={6}
        aria-label="Account menu"
        aria-expanded={anchor != null}
      >
        <View style={styles.menuBar} />
        <View style={styles.menuBar} />
        <View style={styles.menuBar} />
      </Pressable>

      {anchor ? (
        <AppModal visible transparent animationType="fade" onRequestClose={() => setAnchor(null)}>
          {/* Clicking anywhere else dismisses, the usual way out of a menu. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setAnchor(null)} />
          <View style={[styles.menu, { top: anchor.top, right: anchor.right }]}>
            <Text style={styles.menuEmail} numberOfLines={1}>
              {email ?? 'Signed in'}
            </Text>
            <Text style={styles.menuRole}>{role ? `${role} · operator` : 'operator'}</Text>
            <Pressable
              onPress={() => signOut()}
              style={({ hovered }) => [styles.menuAction, hovered && styles.menuActionHovered]}
            >
              <Text style={styles.menuActionText}>Sign out</Text>
            </Pressable>
          </View>
        </AppModal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: theme.bentoPage },
  root: { flex: 1, flexDirection: 'row' },
  rootCompact: { flexDirection: 'column' },

  // No border down the edge: bento has none, so the rail simply sits on the
  // grey page and the selected pill is the only white in it.
  rail: { width: 196, paddingLeft: 18, paddingTop: 22, paddingBottom: 22 },
  brand: { fontSize: 14, fontWeight: '800', letterSpacing: 1.5, color: theme.bentoInk },
  brandSub: { fontSize: 9.5, fontWeight: '800', letterSpacing: 2.4, color: theme.bentoMuted, marginBottom: 20 },
  nav: { gap: 2 },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },
  navItemActive: { backgroundColor: theme.bentoSurface },
  navItemHovered: { backgroundColor: `${theme.bentoSurface}99` },
  navText: { fontSize: 13, fontWeight: '700', color: theme.bentoMuted },
  navTextActive: { color: theme.bentoInk },
  navCount: {
    minWidth: 19,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
    backgroundColor: theme.bentoInk,
  },
  navCountText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoSurface, textAlign: 'center' },

  menuButton: {
    width: 38,
    height: 38,
    borderRadius: 13,
    backgroundColor: theme.bentoSurface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  menuButtonActive: { backgroundColor: theme.bentoSoft },
  menuBar: { width: 15, height: 1.5, borderRadius: 1, backgroundColor: theme.bentoInk },
  // `top` and `right` come from the measured button, so this is positioned
  // against the window rather than against a parent it no longer has.
  menu: {
    position: 'absolute',
    minWidth: 224,
    backgroundColor: theme.bentoSurface,
    borderRadius: BENTO_RADIUS_TILE,
    paddingVertical: 13,
    paddingHorizontal: 15,
    shadowColor: theme.bentoInk,
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  menuEmail: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
  menuRole: { fontSize: 10.5, color: theme.bentoMuted, textTransform: 'capitalize', marginTop: 2 },
  menuAction: {
    marginTop: 12,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  menuActionHovered: { opacity: 0.7 },
  menuActionText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoLoss },

  main: { flex: 1 },
  mainContent: { padding: 18, paddingBottom: 60 },
  mainContentCompact: { padding: 14, paddingBottom: 48 },

  mobileBrand: { marginBottom: 14 },
  brandCompact: { fontSize: 11.5, fontWeight: '800', letterSpacing: 1.5, color: theme.bentoInk },
  tabBar: { marginBottom: 16 },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  headerTitles: { flexShrink: 1, minWidth: 240 },
  eyebrow: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, color: theme.bentoMuted, marginBottom: 3 },
  title: { color: theme.bentoInk, fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  blurb: { color: theme.bentoMuted, fontSize: 13, marginTop: 3, maxWidth: 680 },

  spinner: { marginTop: 40 },
});
