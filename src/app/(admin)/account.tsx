import { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CategoryChip } from '@/components/category-chip';
import { ScreenHeader } from '@/components/screen-header';
import { SegmentedControl } from '@/components/segmented-control';
import { useAuth } from '@/hooks/use-auth';
import { ALL_PERMISSIONS, expandPermissions, IMPLIED_PERMISSIONS, PERMISSIONS, type Permission } from '@/lib/permissions';
import {
  countStaffByRole,
  createRole,
  deleteRole,
  listRoles,
  listStaff,
  provisionStaff,
  setStaffActive,
  updateRole,
  updateStaffRole,
} from '@/lib/staff';
import type { Role, StaffMember } from '@/types/models';

type AccountSection = 'roles' | 'staff';
const sectionOptions: { key: AccountSection; label: string }[] = [
  { key: 'roles', label: 'Roles' },
  { key: 'staff', label: 'Staff' },
];

export default function AccountScreen() {
  const { shop } = useAuth();
  // Gated on `staff.manage` by the route guard in (admin)/_layout.tsx, and by
  // the roles/shop_members RLS behind it (migration 0024). Provisioning a
  // *login* is still owner-only, though -- creating an auth.users row needs
  // the service role, and the provision-staff Edge Function checks
  // staff.manage itself.
  const [section, setSection] = useState<AccountSection>('roles');
  const [roles, setRoles] = useState<Role[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roleUsage, setRoleUsage] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    const [rolesResult, staffResult, usageResult] = await Promise.allSettled([
      listRoles(shop.id),
      listStaff(shop.id),
      countStaffByRole(shop.id),
    ]);
    if (rolesResult.status === 'fulfilled') setRoles(rolesResult.value);
    if (staffResult.status === 'fulfilled') setStaff(staffResult.value);
    if (usageResult.status === 'fulfilled') setRoleUsage(usageResult.value);
    const firstRejected = [rolesResult, staffResult, usageResult].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setError(firstRejected ? (firstRejected.reason instanceof Error ? firstRejected.reason.message : 'Could not load account data.') : null);
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  if (!shop) return null;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safeArea}>
      <ScreenHeader title="Staff & Roles" />
      <View style={styles.sectionNav}>
        <SegmentedControl options={sectionOptions} value={section} onChange={setSection} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {error && <Text style={styles.error}>{error}</Text>}
        {loading ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : section === 'roles' ? (
          <RolesSection shopId={shop.id} roles={roles} usage={roleUsage} onChange={reload} />
        ) : (
          <StaffSection shopId={shop.id} staff={staff} roles={roles} onChange={reload} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function RolesSection({
  shopId,
  roles,
  usage,
  onChange,
}: {
  shopId: string;
  roles: Role[];
  usage: Map<string, number>;
  onChange: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>ROLES</Text>
          <Text style={styles.hint}>Define what each role can do, then assign staff to it below.</Text>
        </View>
        <Pressable onPress={() => setEditing('new')} style={styles.manageButton}>
          <Text style={styles.manageButtonText}>New role</Text>
        </Pressable>
      </View>

      {roles.length === 0 ? (
        <Text style={styles.empty}>No roles yet — create one to start adding staff.</Text>
      ) : (
        roles.map((role) => (
          <Pressable key={role.id} onPress={() => setEditing(role)} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{role.name}</Text>
              <Text style={styles.rowSubLabel}>
                {role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'} · {usage.get(role.id) ?? 0} staff
              </Text>
            </View>
            <Text style={styles.rowActionText}>Edit</Text>
          </Pressable>
        ))
      )}

      <RoleEditorModal
        visible={editing !== null}
        role={editing === 'new' ? null : editing}
        usageCount={editing && editing !== 'new' ? (usage.get(editing.id) ?? 0) : 0}
        onClose={() => setEditing(null)}
        onSave={async (input) => {
          if (editing && editing !== 'new') await updateRole(editing.id, input);
          else await createRole(shopId, input.name!, input.permissions ?? []);
          await onChange();
          setEditing(null);
        }}
        onDelete={
          editing && editing !== 'new'
            ? async () => {
                await deleteRole(editing.id);
                await onChange();
                setEditing(null);
              }
            : undefined
        }
      />
    </View>
  );
}

function RoleEditorModal({
  visible,
  role,
  usageCount,
  onClose,
  onSave,
  onDelete,
}: {
  visible: boolean;
  role: Role | null;
  usageCount: number;
  onClose: () => void;
  onSave: (input: { name?: string; permissions?: string[] }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(role?.name ?? '');
      setPermissions(role?.permissions ?? []);
      setError(null);
    }
  }, [visible, role]);

  // The DB checks each permission literally (`'inventory.view' = any(...)`),
  // so an implication has to be materialized into the stored array rather
  // than left for a reader to infer: switching on "Edit inventory" also
  // switches on "View inventory", and switching the view off switches the
  // edit off with it instead of leaving a role that can write a table it
  // can't read.
  const togglePermission = (key: Permission) => {
    setPermissions((current) => {
      if (!current.includes(key)) return expandPermissions([...current, key]);
      const dependents = ALL_PERMISSIONS.filter((p) => (IMPLIED_PERMISSIONS[p] ?? []).includes(key));
      return current.filter((p) => p !== key && !dependents.includes(p as Permission));
    });
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmed, permissions: expandPermissions(permissions) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this role.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!onDelete) return;
    if (usageCount > 0) {
      setError(`${usageCount} staff member${usageCount === 1 ? '' : 's'} still use this role — reassign them first.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this role.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{role ? 'Edit role' : 'New role'}</Text>
            <View style={styles.modalHeaderActions}>
              <Pressable onPress={save} disabled={saving || !name.trim()} style={[styles.addButton, (saving || !name.trim()) && styles.saveButtonDisabled]}>
                <Text style={styles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.modalClose}><Text style={styles.modalCloseText}>Close</Text></Pressable>
            </View>
          </View>
          <ScrollView style={styles.modalList}>
            <Text style={styles.fieldLabel}>ROLE NAME</Text>
            <TextInput value={name} onChangeText={setName} placeholder="e.g. Cashier" placeholderTextColor="#999999" style={styles.input} />
            <Text style={[styles.fieldLabel, { marginTop: 16 }]}>PERMISSIONS</Text>
            {PERMISSIONS.map((p) => (
              <Pressable key={p.key} onPress={() => togglePermission(p.key)} style={styles.permissionRow}>
                <Switch value={permissions.includes(p.key)} onValueChange={() => togglePermission(p.key)} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowLabel}>{p.label}</Text>
                  <Text style={styles.rowSubLabel}>{p.description}</Text>
                </View>
              </Pressable>
            ))}
            {error && <Text style={styles.error}>{error}</Text>}
            <View style={styles.promoFormActions}>
              {onDelete && (
                <Pressable onPress={remove} disabled={saving} style={styles.rowAction}>
                  <Text style={styles.rowActionTextDanger}>Delete role</Text>
                </Pressable>
              )}
              <Pressable onPress={save} disabled={saving || !name.trim()} style={[styles.addButton, (saving || !name.trim()) && styles.saveButtonDisabled]}>
                <Text style={styles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function StaffSection({
  shopId,
  staff,
  roles,
  onChange,
}: {
  shopId: string;
  staff: StaffMember[];
  roles: Role[];
  onChange: () => Promise<void>;
}) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>STAFF</Text>
          <Text style={styles.hint}>People who can sign in to this shop with a role you&apos;ve assigned.</Text>
        </View>
        <Pressable
          onPress={() => setAddOpen(true)}
          disabled={roles.length === 0}
          style={[styles.manageButton, roles.length === 0 && styles.saveButtonDisabled]}
        >
          <Text style={styles.manageButtonText}>Add staff</Text>
        </Pressable>
      </View>
      {roles.length === 0 && <Text style={styles.hint}>Create a role first, then you can add staff to it.</Text>}

      {staff.length === 0 ? (
        <Text style={styles.empty}>No staff yet.</Text>
      ) : (
        staff.map((member) => (
          <StaffRow key={member.id} member={member} roles={roles} onChange={onChange} />
        ))
      )}

      <AddStaffModal visible={addOpen} shopId={shopId} roles={roles} onClose={() => setAddOpen(false)} onChange={onChange} />
    </View>
  );
}

function StaffRow({ member, roles, onChange }: { member: StaffMember; roles: Role[]; onChange: () => Promise<void> }) {
  const [changingRole, setChangingRole] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <View style={[styles.row, { flexDirection: 'column', alignItems: 'stretch' }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowLabel}>{member.fullName ?? member.email ?? 'Staff member'}</Text>
          <Text style={styles.rowSubLabel}>{member.email} · {member.roleName}</Text>
        </View>
        <Pressable onPress={() => setChangingRole((v) => !v)} style={styles.rowAction}>
          <Text style={styles.rowActionText}>Change role</Text>
        </Pressable>
        <Pressable onPress={() => run(async () => { await setStaffActive(member.id, !member.active); await onChange(); })} style={styles.rowAction}>
          <Text style={member.active ? styles.rowActionText : styles.rowActionTextMuted}>{member.active ? 'Active' : 'Disabled'}</Text>
        </Pressable>
      </View>
      {changingRole && (
        <View style={styles.promoRow}>
          {roles.map((role) => (
            <CategoryChip
              key={role.id}
              label={role.name}
              active={role.id === member.roleId}
              onPress={() => run(async () => { await updateStaffRole(member.id, role.id); await onChange(); setChangingRole(false); })}
            />
          ))}
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function AddStaffModal({
  visible,
  shopId,
  roles,
  onClose,
  onChange,
}: {
  visible: boolean;
  shopId: string;
  roles: Role[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; temporaryPassword: string | null } | null>(null);

  useEffect(() => {
    if (visible) {
      setFullName('');
      setEmail('');
      setPassword('');
      setRoleId(roles[0]?.id ?? null);
      setError(null);
      setResult(null);
    }
  }, [visible, roles]);

  const submit = async () => {
    if (!fullName.trim() || !email.trim() || !roleId) return;
    setSaving(true);
    setError(null);
    try {
      const created = await provisionStaff({ shopId, fullName: fullName.trim(), email: email.trim(), password: password.trim() || undefined, roleId });
      await onChange();
      setResult({ email: created.email, temporaryPassword: created.temporaryPassword });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this staff member.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Add staff</Text>
            <View style={styles.modalHeaderActions}>
              {!result && (
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[styles.addButton, (saving || !fullName.trim() || !email.trim() || !roleId) && styles.saveButtonDisabled]}
                >
                  <Text style={styles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} style={styles.modalClose}><Text style={styles.modalCloseText}>Close</Text></Pressable>
            </View>
          </View>
          <ScrollView style={styles.modalList}>
            {result ? (
              <View>
                <Text style={styles.rowLabel}>Account created for {result.email}</Text>
                {result.temporaryPassword && (
                  <>
                    <Text style={[styles.hint, { marginTop: 8 }]}>
                      Share this password with them now — it won&apos;t be shown again.
                    </Text>
                    <View style={styles.readOnlyField}>
                      <Text selectable style={styles.readOnlyFieldText}>{result.temporaryPassword}</Text>
                    </View>
                  </>
                )}
                <Pressable onPress={onClose} style={[styles.addButton, { marginTop: 16, alignSelf: 'flex-start' }]}>
                  <Text style={styles.addButtonText}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={styles.fieldLabel}>FULL NAME</Text>
                <TextInput value={fullName} onChangeText={setFullName} placeholder="Full name" placeholderTextColor="#999999" style={styles.input} />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>EMAIL</Text>
                <TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor="#999999" autoCapitalize="none" keyboardType="email-address" style={styles.input} />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>PASSWORD (leave blank to generate one)</Text>
                <TextInput value={password} onChangeText={setPassword} placeholder="At least 6 characters" placeholderTextColor="#999999" style={styles.input} />
                <Text style={[styles.fieldLabel, { marginTop: 10 }]}>ROLE</Text>
                <View style={styles.promoRow}>
                  {roles.map((role) => (
                    <CategoryChip key={role.id} label={role.name} active={role.id === roleId} onPress={() => setRoleId(role.id)} />
                  ))}
                </View>
                {error && <Text style={styles.error}>{error}</Text>}
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[styles.addButton, { marginTop: 16, alignSelf: 'flex-start' }, (saving || !fullName.trim() || !email.trim() || !roleId) && styles.saveButtonDisabled]}
                >
                  <Text style={styles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  sectionNav: { paddingHorizontal: 24, paddingTop: 16, maxWidth: 640, width: '100%', alignSelf: 'center' },
  content: { padding: 24, paddingBottom: 60, maxWidth: 640, width: '100%', alignSelf: 'center' },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
  section: { marginBottom: 32 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: '800', color: '#111111', letterSpacing: 0.6, marginBottom: 4 },
  hint: { fontSize: 12, color: '#999999', lineHeight: 17 },
  empty: { fontSize: 13, color: '#999999' },
  manageButton: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 },
  manageButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },

  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  rowSubLabel: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  rowActionTextMuted: { fontSize: 12, fontWeight: '700', color: '#999999' },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },

  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },

  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  readOnlyField: { backgroundColor: '#F7F7F7', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, marginTop: 8 },
  readOnlyFieldText: { color: '#111111', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },

  promoRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4 },
  promoFormActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 },

  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  saveButtonDisabled: { backgroundColor: '#CCCCCC' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modalTitle: { fontSize: 16, fontWeight: '800', color: '#111111' },
  modalClose: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  modalCloseText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  modalList: { flex: 1 },
});
