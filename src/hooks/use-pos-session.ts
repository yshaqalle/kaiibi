import { useCallback, useState } from 'react';

import type { SelectedCustomer } from '@/components/customer-picker';
import type { CartLine, Discount, PaymentLine } from '@/types/models';

type PosSession = {
  cart: CartLine[];
  payments: PaymentLine[];
  selectedCustomer: SelectedCustomer | null;
  cashierName: string | null;
  transactionDiscount: Discount | null;
  // Points the cashier has entered against the attached customer. Held here
  // with the rest of the in-progress sale so a tab switch mid-checkout doesn't
  // silently drop the redemption and change the total.
  pointsRedeemed: number;
};

// Module-level, not component state: the admin tab shell renders the
// active tab through Expo Router's `<Slot />` rather than a persistent tab
// navigator, so it fully unmounts PosScreen on every tab switch (web at any
// width, native tablets) -- every `useState` initializer would otherwise
// reset to empty each time a cashier checks another menu and comes back.
// Holding the in-progress sale here instead means it survives that
// remount; it only resets on a full app reload.
const session: PosSession = {
  cart: [],
  payments: [],
  selectedCustomer: null,
  cashierName: null,
  transactionDiscount: null,
  pointsRedeemed: 0,
};

export function usePosSessionField<K extends keyof PosSession>(key: K) {
  const [value, setValue] = useState<PosSession[K]>(session[key]);
  // Stable identity (like the setter useState itself returns), so it's
  // safe to omit from effect/callback dependency arrays at call sites.
  const update = useCallback((next: PosSession[K] | ((prev: PosSession[K]) => PosSession[K])) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (prev: PosSession[K]) => PosSession[K])(prev) : next;
      session[key] = resolved;
      return resolved;
    });
  }, [key]);
  return [value, update] as const;
}
