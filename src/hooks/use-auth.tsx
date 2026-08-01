import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import type { Permission } from '@/lib/permissions';
import { getMyShop } from '@/lib/shops';
import { getMyPermissions } from '@/lib/staff';
import { supabase } from '@/lib/supabase';
import type { Profile, Shop } from '@/types/models';

type AuthState = {
  session: Session | null;
  profile: Profile | null;
  shop: Shop | null;
  // What this user's role grants in `shop` — the whole catalog for the admin
  // who owns it, their role's expanded permission set for staff, empty when
  // there's no shop resolved yet. Consumers should use `can()` rather than
  // reading this directly.
  permissions: Permission[];
  can: (permission: Permission) => boolean;
  loading: boolean;
  refreshShop: () => Promise<void>;
  // Settings' profile editor already gets the freshly-updated row back from
  // `updateProfile()`, so this just adopts it into context directly rather
  // than a refetch — same effect as `refreshShop`, one less round trip.
  setProfile: (profile: Profile) => void;
};

const noPermissions: Permission[] = [];

// Permissions are always fetched together with the shop they apply to and
// written under the same sequence guard, so the two can never disagree —
// gating UI on a stale permission set is exactly the bug this is here to fix.
//
// The user is resolved here rather than taken from `session` state so this
// stays callable the moment a shop is created during signup, before React has
// committed the session that triggered it (the same reason `getMyShop()` asks
// Supabase for the user itself).
async function loadShopAndPermissions(): Promise<{ shop: Shop | null; permissions: Permission[] }> {
  const [{ data: userData }, shop] = await Promise.all([supabase.auth.getUser(), getMyShop()]);
  const userId = userData.user?.id;
  if (!shop || !userId) return { shop, permissions: noPermissions };
  try {
    return { shop, permissions: await getMyPermissions(shop, userId) };
  } catch {
    // Fail closed: an unresolved permission set must never read as "allow
    // everything". Swallowed rather than rethrown so a failure here can't
    // reject loadForSession() and strand the app on its loading spinner —
    // the session still resolves, the user just lands on the "no access"
    // screen and can retry. Only staff can reach this: an admin's
    // permissions come from owning the shop, with no round trip to fail.
    return { shop, permissions: noPermissions };
  }
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>(noPermissions);
  const [loading, setLoading] = useState(true);
  // Two independent counters guard against out-of-order async writes, one per
  // logically distinct concern:
  // - `loadSeq` guards a whole loadForSession() run (its `profile` write and
  //   final `setLoading(false)`): if a newer session-load has started since this
  //   one began, this one's results are stale and must not be applied.
  // - `shopSeq` guards `shop` and the `permissions` fetched alongside it (both
  //   written in the same guarded block), because it can be written by two
  //   independent callers running concurrently: loadForSession's own fetch (as
  //   part of a session reload) and an explicit refreshShop() call (e.g. right
  //   after creating a shop during admin signup). These must NOT share a counter
  //   with loadSeq: an earlier version of this guard used a single shared
  //   counter, which meant refreshShop() bumping "its" sequence could cause an
  //   unrelated, still in-flight profile fetch inside loadForSession to be
  //   discarded -- silently leaving `profile: null` after a fresh signup and
  //   bouncing the new admin back to /signup. Keeping `shop` on its own counter
  //   preserves "last-started-shop-fetch-wins" without that cross-field damage.
  //
  // `session` itself is set synchronously, before any await, in every
  // loadForSession call. Because there's no async gap before that assignment,
  // whichever call was most recently *invoked* always applies its session value
  // last, in deterministic call order -- there's no resolution-order race to
  // guard against, so `session` intentionally has no counter.
  const loadSeq = useRef(0);
  const shopSeq = useRef(0);
  // Tracks whose data `profile`/`shop` currently hold, so loadForSession can
  // tell "a different user just signed in" (must re-arm `loading` so
  // consumers like AdminLayout wait for the new profile instead of judging
  // the stale one) apart from "same user, background token refresh" (must
  // NOT re-arm `loading`, or every silent refresh would flash a spinner over
  // an already-loaded dashboard). `undefined` means "no session resolved
  // yet" -- distinct from `null` (resolved as signed-out) so the very first
  // loadForSession call always counts as a change.
  const lastUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    const loadForSession = async (nextSession: Session | null) => {
      if (!active) return;
      const myLoadId = ++loadSeq.current;
      const nextUserId = nextSession?.user.id ?? null;
      if (lastUserId.current !== nextUserId) setLoading(true);
      lastUserId.current = nextUserId;
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
        setShop(null);
        setPermissions(noPermissions);
        setLoading(false);
        return;
      }
      const { data: profileRow } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', nextSession.user.id)
        .single();
      if (!active || loadSeq.current !== myLoadId) return;
      setProfile(
        profileRow
          ? {
              id: profileRow.id,
              role: profileRow.role,
              fullName: profileRow.full_name,
              phone: profileRow.phone,
              passwordChangedAt: profileRow.password_changed_at,
              createdAt: profileRow.created_at,
            }
          : null
      );
      const myShopId = ++shopSeq.current;
      const resolved = await loadShopAndPermissions();
      if (!active || loadSeq.current !== myLoadId) return;
      if (shopSeq.current === myShopId) {
        setShop(resolved.shop);
        setPermissions(resolved.permissions);
      }
      setLoading(false);
    };

    supabase.auth.getSession().then(({ data }) => loadForSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      loadForSession(nextSession);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const refreshShop = async () => {
    const myShopId = ++shopSeq.current;
    const resolved = await loadShopAndPermissions();
    if (shopSeq.current !== myShopId) return;
    setShop(resolved.shop);
    setPermissions(resolved.permissions);
  };

  const can = (permission: Permission) => permissions.includes(permission);

  return (
    <AuthContext.Provider value={{ session, profile, shop, permissions, can, loading, refreshShop, setProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
