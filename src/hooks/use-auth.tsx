import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

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

  useEffect(() => {
    let active = true;

    const loadForSession = async (nextSession: Session | null) => {
      if (!active) return;
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
        setShop(null);
        setLoading(false);
        return;
      }
      const { data: profileRow } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', nextSession.user.id)
        .single();
      if (!active) return;
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
      if (!active) return;
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

  return (
    <AuthContext.Provider
      value={{ session, profile, shop, loading, refreshShop: async () => setShop(await getMyShop()) }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
