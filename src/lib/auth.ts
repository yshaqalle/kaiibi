import { clearStoredDraft } from '@/lib/support-draft';
import { supabase } from '@/lib/supabase';

// An unsent support draft is the one thing this app leaves on a device that
// nobody else may read: it is where a cashier writes about their manager, and
// these are shared shop tablets. Its key holds the user id, which is enough to
// stop it being restored into the next person's form but not enough to stop
// anyone who knows the key, so signing out takes the words with it. Read from
// the local session rather than getUser(): the network must not decide whether
// this happens.
async function forgetSupportDraft() {
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (userId) clearStoredDraft(userId);
  } catch {
    // Never block a sign-out on housekeeping.
  }
}

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
  await forgetSupportDraft();
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
  // This device is one of the ones being signed out, so it has the same draft
  // to forget as signOut() above.
  await forgetSupportDraft();
  const { error } = await supabase.auth.signOut({ scope: 'global' });
  if (error) throw error;
}
