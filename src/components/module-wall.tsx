import { useRouter } from 'expo-router';
import { useState, type ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { SupportSheet } from '@/components/support/support-sheet';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { MODULES, type Module } from '@/lib/entitlements';

// Pinned to the light palette -- no dark mode yet, the same as every other
// admin surface.
const theme = Colors.light;

/**
 * The screen a shop sees where a screen its plan doesn't cover would be.
 *
 * This used to render in `(admin)/_layout.tsx`, in place of the `(admin)`
 * Stack, and that placement was the whole defect. Unmounting a navigator in
 * the middle of a client-side transition tears its route out of the navigation
 * state: the pathname collapsed from `/storefront` to `/`, the Stack was
 * rebuilt at its initial route, and `(tabs)/me` -- a bare
 * `<Redirect href="/people" />` -- bounced the shop onto Customers. So the
 * greyed 🔒 rows never once reached the wall they advertise, and the shop's
 * Dashboard was a full-screen paywall with no rail, no ☰ and no tab bar.
 *
 * It renders per SCREEN instead, inside whatever shell is already around that
 * screen. Two things follow, and both are the point:
 *
 *   - the navigator is never unmounted, so the route the shop asked for is the
 *     route it gets, and `/storefront` lands in history like anything else;
 *   - the shell survives. A lapsed shop falls back to `free`, which still
 *     carries POS and Inventory -- screens it can use, and now ones it can
 *     still reach, because the rail is still there beside the wall.
 *
 * Permissions are still answered FIRST, in `(admin)/_layout.tsx`, and still
 * win: a screen this component would offer to sell is one the layout has
 * already agreed the person's role may open. Someone whose role doesn't grant
 * a screen is redirected before any of this renders, which is the more
 * specific -- and more useful -- answer.
 *
 * Says plainly that nothing has been lost. A shop that opens Accounting after
 * a lapse and sees only a paywall will assume its books are gone -- the most
 * damaging thing this screen could imply, and the least true.
 */
export function UpgradeWall({ module, title }: { module: Module; title?: string }) {
  const router = useRouter();
  const { entitlements } = useAuth();
  const meta = MODULES.find((m) => m.key === module);
  const [supportOpen, setSupportOpen] = useState(false);

  // The lookup failed, so we genuinely don't know what this shop is entitled
  // to. Access stays closed -- the server would refuse the writes anyway --
  // but telling a possibly-paid-up customer that this "isn't on your plan"
  // would be a false accusation dressed up as an upsell.
  //
  // The copy calls this transient, but there is no retry: a failed entitlement
  // fetch leaves `resolved` false until the next full auth reload.
  if (!entitlements.resolved) {
    return (
      <Frame title={title}>
        <Text style={styles.title}>Just a moment</Text>
        <Text style={styles.body}>
          We couldn&apos;t check your plan just now, so this screen is on hold. This is a problem on our side, not
          with your account.
        </Text>
        <Pressable onPress={() => setSupportOpen(true)} accessibilityRole="button" accessibilityLabel="Contact support">
          <Text style={styles.support}>Contact support</Text>
        </Pressable>
        <SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
      </Frame>
    );
  }

  return (
    <Frame title={title}>
      <Text style={styles.lock}>🔒</Text>
      <Text style={styles.title}>{meta?.label ?? 'This feature'} isn&apos;t on your plan</Text>
      <Text style={styles.body}>{meta?.description}</Text>
      <Text style={styles.reassure}>
        Anything you already added is safe and still here — it just can&apos;t be changed until your plan covers
        this again.
      </Text>
      <Pressable onPress={() => setSupportOpen(true)} accessibilityRole="button" accessibilityLabel="Contact support">
        <Text style={styles.support}>Contact support</Text>
      </Pressable>
      <SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
      <Pressable onPress={() => router.push('/settings')} style={styles.button}>
        <Text style={styles.buttonText}>See plans</Text>
      </Pressable>
    </Frame>
  );
}

// A tab route sits inside the admin shell, which already carries the rail, the
// ☰ and the bottom bar -- the wall just fills the slot. A route that is PUSHED
// over that shell (Storefront, Orders, the product editors) has no such
// furniture of its own, so it brings the same `ScreenHeader` every other pushed
// screen brings, and its Back/Home are the way out.
function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
  if (!title) return <View style={styles.wall}>{children}</View>;
  return (
    <View style={styles.framed}>
      <ScreenHeader title={title} />
      <View style={styles.wall}>{children}</View>
    </View>
  );
}

/**
 * Wraps a route's own component so the wall takes its place when the shop's
 * plan doesn't cover it.
 *
 * The module is named here rather than derived from the pathname so this needs
 * no router at all. That is also why `ROUTE_MODULES` in `entitlements.ts` is no
 * longer the RUNTIME authority for routes: nothing consults it to decide
 * whether a screen is walled. The hardcoded module literal in each route file's
 * own `withModuleWall(...)` call is what decides that. `ROUTE_MODULES` now only
 * drives the navs' 🔒 derivation (`moduleForPath` in admin-sidebar.tsx and
 * admin-tabs.web.tsx) and the test below.
 *
 * The only guard against a future route forgetting the wrapper is
 * `src/__tests__/module-wall.test.tsx:219-228`, and it is worth knowing its
 * limit: it is a SOURCE-TEXT check. It walks every route file under `(admin)`
 * and, for each one `moduleForPath()` says is gated, asserts the file's text
 * contains `withModuleWall('<module>'`. It never renders the route, so it
 * cannot tell whether the wrapped component is the one actually exported as
 * default -- a file that calls `withModuleWall` and then exports the unwrapped
 * screen passes.
 *
 * The wrapped screen is not rendered at all when the wall is up, so a walled
 * screen never mounts and never fires the queries it would have made.
 */
export function withModuleWall<P extends object>(
  module: Module,
  Screen: ComponentType<P>,
  options: { title?: string } = {}
): ComponentType<P> {
  function Walled(props: P) {
    const { hasModule } = useAuth();
    if (!hasModule(module)) return <UpgradeWall module={module} title={options.title} />;
    return <Screen {...props} />;
  }
  Walled.displayName = `withModuleWall(${Screen.displayName ?? Screen.name ?? 'Screen'})`;
  return Walled;
}

const styles = StyleSheet.create({
  framed: { flex: 1, backgroundColor: theme.bentoSurface },
  wall: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 10,
    backgroundColor: theme.bentoSurface,
  },
  title: { color: theme.bentoInk, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  body: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', maxWidth: 320, lineHeight: 19 },
  support: { fontSize: 13.5, fontWeight: '800', color: theme.bentoAccentInk, marginBottom: 14 },
  lock: { fontSize: 30, marginBottom: 2 },
  // The one amber line on the screen, and it is reassurance rather than alarm:
  // `bentoWarn` is the ramp's amber, the same one the warning tone is built on.
  reassure: { color: theme.bentoWarn, fontSize: 12, textAlign: 'center', maxWidth: 320, lineHeight: 18, marginTop: 2 },
  button: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 11, marginTop: 10 },
  buttonText: { color: theme.bentoSurface, fontSize: 12, fontWeight: '800' },
});
