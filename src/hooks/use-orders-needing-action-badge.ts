import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { useStorefrontNavState } from '@/hooks/use-storefront-nav';
import { countOrdersNeedingAction } from '@/lib/storefront-admin';

// How many orders are waiting on the shop, as ONE number.
//
// Task 7: publishing a storefront is retroactively consent to take orders, and
// a shop that never thinks to open the Orders row would otherwise never find
// out one arrived.
//
// A COUNT EXISTS EXACTLY WHEN THE ROW IT LABELS DOES, which is why the gate
// here is useStorefrontNavState() and not a second opinion assembled from
// `hasModule` and the storefronts row. Every surface this badge appears on --
// the ☰ button, the Orders row inside it, the Settings pane's own Orders row
// -- is pointing at the same door, so a dot with no door behind it is a
// notification about a screen the reader will be bounced off.
//
// Both halves of that state matter here, in opposite directions:
//
//   'locked'  a lapsed shop. NOT silenced, and that is the whole point -- it
//             loses the module but not its customers, the orders it already
//             took still exist, still need picking, and are still readable
//             (the `orders` and `storefronts` policies gate on shop
//             membership; the module gates are triggers on WRITE --
//             20260926000050:147, 20260924000000:82). Gating on the module
//             would drop the count to zero for exactly the shop whose
//             customers are still waiting.
//   'hidden'  no page to come back to, still resolving -- or a reader without
//             `settings.access`. That last one is the fix for a paying shop's
//             cashier, who got a dot with no Orders row behind it: `/orders`
//             requires `settings.access` (permissions.ts) and (admin)/
//             _layout.tsx redirects on it, so the screen the dot pointed at
//             was one they could not open. The lapsed path was already gated
//             this way; this is the other half of the same rule.
//
// Refetched on focus rather than polled -- see use-refresh-on-focus.ts's own
// header for why a timer here would cost a shop on data it pays for by the
// megabyte. Nothing here is pushed: another till or another phone that changes
// an order still needs a re-focus to pick it up.
//
// N3: this used to be listOrders(shop.id) -- every order the shop has ever
// placed, every column, nested order_items included -- filtered client-side
// for one integer, on EVERY focus of a screen most shops open several times a
// day. countOrdersNeedingAction does the filtering server-side and returns
// only the count. That is why this is a COUNT and not a list, and why a second
// caller (the main nav's Orders row, alongside the settings sidebar's) reuses
// this hook rather than fetching orders of its own.
export function useOrdersNeedingActionBadge(): number {
  const { shop } = useAuth();
  const enabled = useStorefrontNavState() !== 'hidden';
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
