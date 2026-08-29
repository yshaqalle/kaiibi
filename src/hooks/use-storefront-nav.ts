import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { getMyStorefront } from '@/lib/storefront-admin';

// What the Storefront and Orders rows should do, as one answer shared by every
// nav that carries them -- which is now the ☰ menu and only the ☰ menu, at
// every width (admin-sidebar.tsx) and on both platforms (the native phone ☰ in
// admin-tabs.tsx). No rail or bar reads this.
//
//   'open'    the shop has the module -- an ordinary row, including through
//             the whole grace month, where the plan is still the shop's own
//   'locked'  the shop HAD a page and no longer has the module -- greyed with
//             the 🔒, landing on the upgrade wall that `withModuleWall`
//             renders inside the route itself (components/module-wall.tsx)
//   'hidden'  no page to come back to, or we do not know yet
//
// There is no "lapsed" flag anywhere to read. A shop past its grace month
// simply falls back to the `free` plan (shop_effective_plan(), migration
// 20260824000100), so the only thing that tells a lapsed shop apart from one
// that never sold online is that a `storefronts` row exists for it.
export type StorefrontNavState = 'hidden' | 'locked' | 'open';

// One answer per shop for the life of the process. The navs render on top of
// every screen, so this must not be a query that repeats -- and the answer it
// caches cannot go stale in a way that matters: a `storefronts` row is never
// deleted (a lapse keeps the data, which is the whole decision), and the only
// transition it can make, null -> row, happens in the editor, which a shop can
// only open while it HAS the module and is therefore already 'open' here.
const presence = new Map<string, Promise<boolean>>();

function storefrontPresence(shopId: string): Promise<boolean> {
  const known = presence.get(shopId);
  if (known) return known;
  const asked = getMyStorefront(shopId).then((row) => row !== null);
  presence.set(shopId, asked);
  // A failure is not an answer. Forgetting it lets the next mount ask again,
  // rather than pinning "no page" -- which would hide the rows from a lapsed
  // shop over one bad request.
  asked.catch(() => presence.delete(shopId));
  return asked;
}

/** Test seam: the cache above outlives a component, so it outlives a test too. */
export function resetStorefrontPresence() {
  presence.clear();
}

/**
 * Does this shop have a `storefronts` row? `null` while unknown -- which
 * covers both "not asked" and "asked, still waiting".
 *
 * Only asked when the answer can change what is on screen: a shop that has the
 * module gets its rows either way, so it is never queried. That keeps the
 * common path free and leaves one request per session for the shops whose plan
 * does not carry storefront.
 */
export function useShopHasStorefront(): boolean | null {
  const { shop, can, hasModule, entitlements } = useAuth();
  const shopId = shop?.id ?? null;
  // `resolved` false means the entitlement lookup did not succeed and this is
  // the fail-closed FREE_FALLBACK rather than the shop's real plan
  // (entitlements.ts). Asking then, and greying a row off the answer, would
  // tell a possibly-paid-up shop its storefront had lapsed -- the same false
  // accusation the upgrade wall refuses to make in components/module-wall.tsx.
  //
  // `settings.access` is in here for a plainer reason: it is the permission
  // useStorefrontNavState() below returns 'hidden' on, so for a cashier the
  // answer cannot change anything on screen. Without it every cashier session
  // at every shop without the `storefront` module spent one request finding
  // out something it would not be allowed to act on.
  const worthAsking = Boolean(shopId) && can('settings.access') && entitlements.resolved && !hasModule('storefront');
  // The answer is stored WITH the shop it is about, so switching shops cannot
  // be answered for a moment by the previous shop's page. A failed lookup is
  // simply never recorded: no answer stays no answer, and the rows stay hidden,
  // which is what they did before any of this existed.
  const [answer, setAnswer] = useState<{ shopId: string; present: boolean } | null>(null);

  useEffect(() => {
    if (!worthAsking || !shopId) return;
    let active = true;
    storefrontPresence(shopId)
      .then((present) => { if (active) setAnswer({ shopId, present }); })
      .catch(() => {});
    return () => { active = false; };
  }, [worthAsking, shopId]);

  return worthAsking && answer?.shopId === shopId ? answer.present : null;
}

/**
 * The nav's whole decision about the two storefront rows.
 *
 * `settings.access` is in here because it is what the route guard checks for
 * both routes (permissions.ts:177,181), and a nav must never offer a door that
 * bounces straight back -- not even a locked one, which would send someone to
 * an upgrade wall for a screen their role could not open even after paying.
 */
export function useStorefrontNavState(): StorefrontNavState {
  const { can, hasModule } = useAuth();
  const hasPage = useShopHasStorefront();
  if (!can('settings.access')) return 'hidden';
  if (hasModule('storefront')) return 'open';
  // `null` -- still resolving -- falls through to 'hidden' deliberately. The
  // rows appear once, in their final state. Showing them unlocked and then
  // locking them, or locked and then unlocking them, are both defects.
  return hasPage === true ? 'locked' : 'hidden';
}
