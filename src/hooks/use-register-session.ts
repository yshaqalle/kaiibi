import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { listRegisters, openSessionAt } from '@/lib/registers';
import type { Register, RegisterSession } from '@/types/models';

// The register state for the store the POS is pointed at: which registers exist
// here, and whether one is open.
//
// Deliberately fails soft. Every branch below leaves `registers` empty and
// `session` null on error, which the POS renders as "no register in use" —
// exactly what a shop that has never set one up sees. A register bar is not
// worth blocking a sale over, and a shop mid-trade should never discover this
// feature through an error message.
export function useRegisterSession() {
  const { shop, activeLocation } = useAuth();
  const [registers, setRegisters] = useState<Register[]>([]);
  const [session, setSession] = useState<RegisterSession | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!shop || !activeLocation) return;
    try {
      const [here, open] = await Promise.all([
        listRegisters(shop.id, activeLocation.id),
        openSessionAt(activeLocation.id),
      ]);
      setRegisters(here.filter((register) => register.active));
      setSession(open);
    } catch {
      setRegisters([]);
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, [shop, activeLocation]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A session can be opened or closed on another device at the same counter, so
  // coming back to this screen re-resolves rather than trusting what was true
  // when it was last mounted.
  useRefreshOnFocus(reload);

  // Derived rather than cleared in an effect: with no shop or no store resolved
  // there is nothing to show, and writing that emptiness into state would mean
  // a synchronous setState on every location switch for no gain.
  const ready = Boolean(shop && activeLocation);
  return {
    registers: ready ? registers : [],
    session: ready ? session : null,
    loading: ready ? loading : false,
    reload,
  };
}
