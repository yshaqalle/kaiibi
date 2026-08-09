import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  canWrite,
  FREE_FALLBACK,
  type Entitlements,
  type LimitResource,
  type Module,
  type SubscriptionStatus,
} from '@/lib/entitlements';
import { resolveActiveLocation } from '@/lib/location-selection';
import { listMyLocations } from '@/lib/locations';
import type { Permission } from '@/lib/permissions';
import { getMyShop } from '@/lib/shops';
import { getMyMembership, getMyPermissions } from '@/lib/staff';
import { getMyEntitlements } from '@/lib/subscriptions';
import { supabase } from '@/lib/supabase';
import type { Profile, Shop, ShopLocation, StaffMember } from '@/types/models';

// Which location this device last operated at. Stored per device, not per user
// and not on the server, because a register belongs to a branch: the till at
// Airport Road stays Airport Road's till no matter which cashier signs in.
const ACTIVE_LOCATION_KEY = 'kaiibi.activeLocationId';

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
  // For routes/nav items valid under more than one permission (e.g. /people,
  // which needs customers.view OR any People-manager permission).
  canAny: (permissions: Permission[]) => boolean;
  // This user's own shop_members row -- null only while unresolved. Powers the
  // self-service /me tab, which is reachable by active membership alone, not
  // any Permission (see src/lib/permissions.ts's ROUTE_PERMISSIONS comment).
  //
  // This used to be null for the owner, who owned the shop instead of belonging
  // to it. Migration 20260823000000 gives them a row like everyone else -- their
  // authority still comes from shops.owner_id, but they can now be scheduled and
  // handed a register, which the foreign keys on those tables require. So the
  // /me tab, the People nav item and the POS's `sessionMember ?? myMembership`
  // fallback all resolve for an owner now where they previously did not.
  myMembership: StaffMember | null;
  // The stores THIS USER may operate at -- their assigned store, or all of the
  // shop's when unassigned (see migration 20260812000000). Inactive ones are
  // included, since Settings lists a closed store to reopen it; anything
  // offering a *choice* filters to `active` (hasMultipleLocations in
  // lib/location-selection.ts).
  //
  // Note this is narrower than "every store the shop has": a cashier assigned
  // to one store sees one entry here and so gets no switcher at all, which is
  // the correct experience for them. Settings -> Store locations reads the full
  // list separately, gated on settings.access.
  locations: ShopLocation[];
  // Where this device is currently operating -- the branch a sale gets recorded
  // at, the stock a POS decrements, the address a receipt prints. Null only
  // while unresolved or signed out.
  activeLocation: ShopLocation | null;
  setActiveLocation: (locationId: string) => void;
  // What the SHOP has paid for, as opposed to what this USER may do. Both
  // gates apply: `can('inventory.edit') && hasModule('inventory')`. Consumers
  // should use the helpers below rather than reading this directly.
  entitlements: Entitlements;
  // Whether the shop's plan includes this module. False also when the account
  // is suspended, whatever the plan says.
  hasModule: (module: Module) => boolean;
  // The cap on a countable resource; null means unlimited.
  limitFor: (resource: LimitResource) => number | null;
  // How many the shop has now, per the server-side counters.
  usageOf: (resource: LimitResource) => number;
  // True when the shop is already at or over the cap, so the next create must
  // be refused. Asked BEFORE creating, hence at-or-over rather than over.
  atLimit: (resource: LimitResource) => boolean;
  subscriptionStatus: SubscriptionStatus;
  // False once expired or suspended. Gates buttons, never screens -- reads stay
  // open at every status so a shop never loses sight of its own books.
  canWriteNow: boolean;
  loading: boolean;
  refreshShop: () => Promise<void>;
  // Settings' profile editor already gets the freshly-updated row back from
  // `updateProfile()`, so this just adopts it into context directly rather
  // than a refetch — same effect as `refreshShop`, one less round trip.
  setProfile: (profile: Profile) => void;
};

const noPermissions: Permission[] = [];
const noLocations: ShopLocation[] = [];

// Permissions are always fetched together with the shop they apply to and
// written under the same sequence guard, so the two can never disagree —
// gating UI on a stale permission set is exactly the bug this is here to fix.
//
// The user is resolved here rather than taken from `session` state so this
// stays callable the moment a shop is created during signup, before React has
// committed the session that triggered it (the same reason `getMyShop()` asks
// Supabase for the user itself).
async function loadShopAndPermissions(): Promise<{
  shop: Shop | null;
  permissions: Permission[];
  myMembership: StaffMember | null;
  locations: ShopLocation[];
  activeLocation: ShopLocation | null;
  entitlements: Entitlements;
}> {
  const [{ data: userData }, shop] = await Promise.all([supabase.auth.getUser(), getMyShop()]);
  const userId = userData.user?.id;
  if (!shop || !userId) {
    return {
      shop,
      permissions: noPermissions,
      myMembership: null,
      locations: noLocations,
      activeLocation: null,
      entitlements: FREE_FALLBACK,
    };
  }
  // Fetched independently -- each with its own fail-closed fallback -- so a
  // failure on one can't cost the other. Permissions failing closed to
  // noPermissions is a security requirement (an unresolved permission set
  // must never read as "allow everything"); myMembership failing to null is
  // just "self-service /me falls back to unavailable", not a security
  // boundary. Coupling them through one shared try/catch (as this used to)
  // meant a merely-flaky membership read -- a plain RLS-gated table read,
  // more failure-prone than the permissions RPC -- could drop an otherwise
  // fully-permissioned staff member all the way to the "no access" screen.
  // Neither promise is allowed to reject past this function, so
  // loadForSession() above is never at risk of being stranded on its
  // loading spinner by either one.
  //
  // Locations joins the same allSettled for the same reason, and fails closed
  // to an empty list: with no location resolved the POS declines to record a
  // sale rather than guessing a branch, which is the safe direction -- a sale
  // filed against the wrong store is far harder to unpick than one that was
  // never rung up.
  //
  // Entitlements join it too, failing closed to the FREE tier rather than to
  // the full catalog. The database is the authority (the module gates and limit
  // triggers in migrations 20260818000300/400 are what actually refuse a
  // write), so a client that briefly under-reports costs a retry, while one
  // that fails *open* would hand every shop the top tier for as long as one RPC
  // was flaky -- and that is the shape a monetization bypass takes. Same
  // direction as `noPermissions` above, for the same reason.
  const [permissionsResult, membershipResult, locationsResult, rememberedResult, entitlementsResult] =
    await Promise.allSettled([
      getMyPermissions(shop, userId),
      getMyMembership(shop.id, userId),
      listMyLocations(shop.id),
      AsyncStorage.getItem(ACTIVE_LOCATION_KEY),
      getMyEntitlements(shop.id),
    ]);
  const permissions = permissionsResult.status === 'fulfilled' ? permissionsResult.value : noPermissions;
  const myMembership = membershipResult.status === 'fulfilled' ? membershipResult.value : null;
  const locations = locationsResult.status === 'fulfilled' ? locationsResult.value : noLocations;
  const rememberedId = rememberedResult.status === 'fulfilled' ? rememberedResult.value : null;
  const entitlements = entitlementsResult.status === 'fulfilled' ? entitlementsResult.value : FREE_FALLBACK;
  return {
    shop,
    permissions,
    myMembership,
    locations,
    activeLocation: resolveActiveLocation(locations, rememberedId),
    entitlements,
  };
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>(noPermissions);
  const [myMembership, setMyMembership] = useState<StaffMember | null>(null);
  const [locations, setLocations] = useState<ShopLocation[]>(noLocations);
  const [activeLocation, setActiveLocationState] = useState<ShopLocation | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements>(FREE_FALLBACK);
  const [loading, setLoading] = useState(true);
  // Two independent counters guard against out-of-order async writes, one per
  // logically distinct concern:
  // - `loadSeq` guards a whole loadForSession() run (its `profile` write and
  //   final `setLoading(false)`): if a newer session-load has started since this
  //   one began, this one's results are stale and must not be applied.
  // - `shopSeq` guards `shop` and the `permissions`/`locations` fetched
  //   alongside it (all written in the same guarded block), because it can be
  //   written by two
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
        setMyMembership(null);
        setLocations(noLocations);
        // The persisted id in AsyncStorage is deliberately left alone: it
        // belongs to the device, not the session, so the next cashier to sign in
        // at this register lands on the same branch.
        setActiveLocationState(null);
        setEntitlements(FREE_FALLBACK);
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
        setMyMembership(resolved.myMembership);
        setLocations(resolved.locations);
        setActiveLocationState(resolved.activeLocation);
        setEntitlements(resolved.entitlements);
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
    setMyMembership(resolved.myMembership);
    setLocations(resolved.locations);
    setActiveLocationState(resolved.activeLocation);
    setEntitlements(resolved.entitlements);
  };

  // Adopts the chosen row into state immediately and persists in the
  // background: the switcher must feel instant, and a failed write to
  // AsyncStorage should cost the device its *memory* of the choice, not the
  // choice itself. An unknown id is ignored rather than clearing the active
  // location -- dropping to null would silently disable checkout.
  const setActiveLocation = (locationId: string) => {
    const next = locations.find((location) => location.id === locationId);
    if (!next) return;
    setActiveLocationState(next);
    AsyncStorage.setItem(ACTIVE_LOCATION_KEY, locationId).catch(() => {});
  };

  const can = (permission: Permission) => permissions.includes(permission);
  const canAny = (perms: Permission[]) => perms.some((p) => permissions.includes(p));

  const hasModule = (module: Module) => entitlements.modules.includes(module);
  // Undefined (a resource the plan never mentions) means unlimited, which is
  // why this returns null rather than 0 -- see shop_limit() in migration
  // 20260818000200 for the same rule on the server.
  const limitFor = (resource: LimitResource) => entitlements.limits[resource] ?? null;
  const usageOf = (resource: LimitResource) => entitlements.usage[resource] ?? 0;
  const atLimit = (resource: LimitResource) => {
    const limit = limitFor(resource);
    return limit != null && usageOf(resource) >= limit;
  };

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        shop,
        permissions,
        can,
        canAny,
        myMembership,
        locations,
        activeLocation,
        setActiveLocation,
        entitlements,
        hasModule,
        limitFor,
        usageOf,
        atLimit,
        subscriptionStatus: entitlements.status,
        canWriteNow: canWrite(entitlements.status),
        loading,
        refreshShop,
        setProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
