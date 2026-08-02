import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { ALL_PERMISSIONS, expandPermissions, IMPLIED_PERMISSIONS, PERMISSIONS, type Permission } from '@/lib/permissions';
import { createRole, deleteRole, provisionStaff, setStaffActive, updateRole, updateStaffRole } from '@/lib/staff';
import type { Role, StaffMember } from '@/types/models';

// Ported from the previous app/(admin)/account.tsx (now unreached from the
// Settings sidebar — "Staff and roles" renders inline here instead of
// navigating to a separately-styled screen). Business logic (createRole,
// provisionStaff, permission toggling, etc.) is unchanged; only the outer
// row/section chrome now uses the shared Settings primitives.

export function StaffPanel({
  shopId,
  roles,
  staff,
  roleUsage,
  onChange,
}: {
  shopId: string;
  roles: Role[];
  staff: StaffMember[];
  roleUsage: Map<string, number>;
  onChange: () => Promise<void>;
}) {
  return (
    <View>
      <PageHeader title="Staff and roles" />
      <RolesSection shopId={shopId} roles={roles} usage={roleUsage} onChange={onChange} />
      <StaffSection shopId={shopId} staff={staff} roles={roles} onChange={onChange} />
    </View>
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
    <Section title={`Roles · ${roles.length}`}>
      <Text style={styles.hint}>Define what each role can do, then assign staff to it below.</Text>
      {roles.length === 0 ? (
        <Text style={styles.empty}>No roles yet — create one to start adding staff.</Text>
      ) : (
        roles.map((role) => (
          <Row key={role.id} label={role.name} desc={`${role.permissions.length} permission${role.permissions.length === 1 ? '' : 's'} · ${usage.get(role.id) ?? 0} staff`}>
            <Btn onPress={() => setEditing(role)}>Edit</Btn>
          </Row>
        ))
      )}
      <View style={styles.actionsRow}>
        <Btn onPress={() => setEditing('new')}>New role</Btn>
      </View>

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
    </Section>
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
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>{role ? 'Edit role' : 'New role'}</Text>
            <View style={modalStyles.headerActions}>
              <Pressable onPress={save} disabled={saving || !name.trim()} style={[modalStyles.addButton, (saving || !name.trim()) && modalStyles.buttonDisabled]}>
                <Text style={modalStyles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={modalStyles.close}>
                <Text style={modalStyles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView style={modalStyles.list}>
            <Text style={modalStyles.fieldLabel}>ROLE NAME</Text>
            <TextInput value={name} onChangeText={setName} placeholder="e.g. Cashier" placeholderTextColor="#999999" style={modalStyles.input} />
            <Text style={[modalStyles.fieldLabel, { marginTop: 16 }]}>PERMISSIONS</Text>
            {PERMISSIONS.map((p) => (
              <Pressable key={p.key} onPress={() => togglePermission(p.key)} style={modalStyles.permissionRow}>
                <Switch value={permissions.includes(p.key)} pointerEvents="none" onValueChange={() => togglePermission(p.key)} />
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.rowLabel}>{p.label}</Text>
                  <Text style={modalStyles.rowSubLabel}>{p.description}</Text>
                </View>
              </Pressable>
            ))}
            {error && <Text style={styles.error}>{error}</Text>}
            <View style={modalStyles.formActions}>
              {onDelete && (
                <Pressable onPress={remove} disabled={saving} style={modalStyles.rowAction}>
                  <Text style={modalStyles.rowActionTextDanger}>Delete role</Text>
                </Pressable>
              )}
              <Pressable onPress={save} disabled={saving || !name.trim()} style={[modalStyles.addButton, (saving || !name.trim()) && modalStyles.buttonDisabled]}>
                <Text style={modalStyles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
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
    <Section title={`Staff · ${staff.length}`}>
      <Text style={styles.hint}>People who can sign in to this store with a role you&apos;ve assigned.</Text>
      {roles.length === 0 && <Text style={styles.hint}>Create a role first, then you can add staff to it.</Text>}

      {staff.length === 0 ? (
        <Text style={styles.empty}>No staff yet.</Text>
      ) : (
        staff.map((member) => <StaffRow key={member.id} member={member} roles={roles} onChange={onChange} />)
      )}

      <View style={styles.actionsRow}>
        <Btn onPress={() => setAddOpen(true)} disabled={roles.length === 0}>
          Add staff
        </Btn>
      </View>

      <AddStaffModal visible={addOpen} shopId={shopId} roles={roles} onClose={() => setAddOpen(false)} onChange={onChange} />
    </Section>
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
    <View>
      <Row label={member.fullName ?? member.email ?? 'Staff member'} desc={`${member.email} · ${member.roleName}`}>
        <Btn onPress={() => setChangingRole((v) => !v)}>Change role</Btn>
        <Btn
          onPress={() =>
            run(async () => {
              await setStaffActive(member.id, !member.active);
              await onChange();
            })
          }
        >
          {member.active ? 'Active' : 'Disabled'}
        </Btn>
      </Row>
      {changingRole && (
        <View style={styles.chipRow}>
          {roles.map((role) => (
            <CategoryChip
              key={role.id}
              label={role.name}
              active={role.id === member.roleId}
              onPress={() =>
                run(async () => {
                  await updateStaffRole(member.id, role.id);
                  await onChange();
                  setChangingRole(false);
                })
              }
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
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>Add staff</Text>
            <View style={modalStyles.headerActions}>
              {!result && (
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[modalStyles.addButton, (saving || !fullName.trim() || !email.trim() || !roleId) && modalStyles.buttonDisabled]}
                >
                  <Text style={modalStyles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} style={modalStyles.close}>
                <Text style={modalStyles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>
          <ScrollView style={modalStyles.list}>
            {result ? (
              <View>
                <Text style={modalStyles.rowLabel}>Account created for {result.email}</Text>
                {result.temporaryPassword && (
                  <>
                    <Text style={[styles.hint, { marginTop: 8 }]}>Share this password with them now — it won&apos;t be shown again.</Text>
                    <View style={modalStyles.readOnlyField}>
                      <Text selectable style={modalStyles.readOnlyFieldText}>
                        {result.temporaryPassword}
                      </Text>
                    </View>
                  </>
                )}
                <Pressable onPress={onClose} style={[modalStyles.addButton, { marginTop: 16, alignSelf: 'flex-start' }]}>
                  <Text style={modalStyles.addButtonText}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={modalStyles.fieldLabel}>FULL NAME</Text>
                <TextInput value={fullName} onChangeText={setFullName} placeholder="Full name" placeholderTextColor="#999999" style={modalStyles.input} />
                <Text style={[modalStyles.fieldLabel, { marginTop: 10 }]}>EMAIL</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor="#999999"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  style={modalStyles.input}
                />
                <Text style={[modalStyles.fieldLabel, { marginTop: 10 }]}>PASSWORD (leave blank to generate one)</Text>
                <TextInput value={password} onChangeText={setPassword} placeholder="At least 6 characters" placeholderTextColor="#999999" style={modalStyles.input} />
                <Text style={[modalStyles.fieldLabel, { marginTop: 10 }]}>ROLE</Text>
                <View style={styles.chipRow}>
                  {roles.map((role) => (
                    <CategoryChip key={role.id} label={role.name} active={role.id === roleId} onPress={() => setRoleId(role.id)} />
                  ))}
                </View>
                {error && <Text style={styles.error}>{error}</Text>}
                <Pressable
                  onPress={submit}
                  disabled={saving || !fullName.trim() || !email.trim() || !roleId}
                  style={[
                    modalStyles.addButton,
                    { marginTop: 16, alignSelf: 'flex-start' },
                    (saving || !fullName.trim() || !email.trim() || !roleId) && modalStyles.buttonDisabled,
                  ]}
                >
                  <Text style={modalStyles.addButtonText}>{saving ? 'Adding…' : 'Add staff'}</Text>
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
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  empty: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingBottom: 11 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginTop: 6 },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  list: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  input: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  readOnlyField: { backgroundColor: '#F7F7F7', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 12, marginTop: 8 },
  readOnlyFieldText: { color: '#111111', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  rowSubLabel: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
