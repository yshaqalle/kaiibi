import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { getMyShop } from '@/lib/shops';
import { supabase } from '@/lib/supabase';
import type { Profile, Shop } from '@/types/models';

type AuthState = {
  session: Session | null;
  profile: Profile | null;
  shop: Shop | null;
  loading: boolean;
  refreshShop: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [loading, setLoading] = useState(true);
  // Guards against out-of-order async writes to `shop`: the SIGNED_IN listener's
  // own fetch and an explicit refreshShop() call (e.g. right after creating a shop
  // during owner signup) can be in flight concurrently. Whichever fetch started
  // most recently should win, even if an earlier-started fetch resolves later with
  // a stale (e.g. pre-shop-creation) result.
  const shopRequestSeq = useRef(0);

  useEffect(() => {
    let active = true;

    const loadForSession = async (nextSession: Session | null) => {
      if (!active) return;
      const requestId = ++shopRequestSeq.current;
      setSession(nextSession);
      if (!nextSession) {
        if (shopRequestSeq.current === requestId) {
          setProfile(null);
          setShop(null);
          setLoading(false);
        }
        return;
      }
      const { data: profileRow } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', nextSession.user.id)
        .single();
      if (!active || shopRequestSeq.current !== requestId) return;
      setProfile(
        profileRow
          ? {
              id: profileRow.id,
              role: profileRow.role,
              fullName: profileRow.full_name,
              phone: profileRow.phone,
              createdAt: profileRow.created_at,
            }
          : null
      );
      const myShop = await getMyShop();
      if (!active || shopRequestSeq.current !== requestId) return;
      setShop(myShop);
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
    const requestId = ++shopRequestSeq.current;
    const myShop = await getMyShop();
    if (shopRequestSeq.current !== requestId) return;
    setShop(myShop);
  };

  return (
    <AuthContext.Provider value={{ session, profile, shop, loading, refreshShop }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
