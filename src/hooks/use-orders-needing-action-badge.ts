import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { useShopHasStorefront } from '@/hooks/use-storefront-nav';
import { countOrdersNeedingAction } from '@/lib/storefront-admin';

// How many orders are waiting on the shop, as ONE number.
//
// Task 7: publishing a storefront is retroactively consent to take orders, and
// a shop that never thinks to open the Orders row would otherwise never find
// out one arrived. Deliberately NOT gated on the `storefront` module alone:
// `enabled` below is `hasModule('storefront') || hasPage === true`, so a shop
// whose plan has lapsed is still asked as long as a `storefronts` row exists
// for it. That is the whole point -- the orders it already took are the ones
// most likely to be forgotten, and the badge is what tells it they are there.
// A shop that never had a page has neither half, so it is never asked.
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
  const { shop, hasModule } = useAuth();
  // A lapsed shop loses the module but not its customers: the orders it has
  // already taken still exist, still need picking, and are still readable (the
  // `orders` and `storefronts` policies gate on shop membership, and the
  // module gates are triggers on WRITE -- 20260926000050:147, 20260924000000:82).
  // Gating this on the module alone would silently drop the count to zero for
  // exactly the shop whose customers are still waiting.
  const hasPage = useShopHasStorefront();
  const enabled = hasModule('storefront') || hasPage === true;
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
