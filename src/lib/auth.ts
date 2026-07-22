import { supabase } from '@/lib/supabase';

export async function signUpOwner(params: { email: string; password: string; fullName: string; phone: string }) {
  const { data, error } = await supabase.auth.signUp({
    email: params.email,
    password: params.password,
    options: { data: { role: 'owner', full_name: params.fullName, phone: params.phone } },
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
