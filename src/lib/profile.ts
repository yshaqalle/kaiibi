import { supabase } from '@/lib/supabase';
import type { Profile } from '@/types/models';

function mapProfileRow(row: any): Profile {
  return { id: row.id, role: row.role, fullName: row.full_name, phone: row.phone, createdAt: row.created_at };
}

export async function updateProfile(id: string, input: Partial<{ fullName: string; phone: string }>): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update({
      ...(input.fullName !== undefined && { full_name: input.fullName }),
      ...(input.phone !== undefined && { phone: input.phone }),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapProfileRow(data);
}
