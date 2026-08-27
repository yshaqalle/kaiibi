import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { countOrdersNeedingAction } from '@/lib/storefront-admin';

// How many orders are waiting on the shop, as ONE number.
//
// Task 7: publishing a storefront is retroactively consent to take orders, and
// a shop that never thinks to open the Orders row would otherwise never find
// out one arrived. Gated on the `storefront` module the same way every entry
// that offers this route is -- a shop without storefront is never even asked.
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
  const enabled = hasModule('storefront');
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
