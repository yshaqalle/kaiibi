import { supabase } from '@/lib/supabase';

export async function signUpAdmin(params: { email: string; password: string; fullName: string; phone: string }) {
  const { data, error } = await supabase.auth.signUp({
    email: params.email,
    password: params.password,
    options: { data: { role: 'admin', full_name: params.fullName, phone: params.phone } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(params: { email: string; password: string }) {
  const { data, error } = await supabase.auth.signInWithPassword(params);
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// Invalidates every refresh token for this account (all devices/tabs,
// including this one) rather than just the current session — Supabase's
// `scope: 'global'` sign-out. There's no client-accessible API to list or
// selectively revoke individual sessions (that needs the service-role admin
// API, server-side only), so this is an all-or-nothing "sign out
// everywhere," not a per-device list.
export async function signOutEverywhere() {
  const { error } = await supabase.auth.signOut({ scope: 'global' });
  if (error) throw error;
}
