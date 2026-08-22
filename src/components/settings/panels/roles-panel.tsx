import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { ALL_PERMISSIONS, expandPermissions, IMPLIED_PERMISSIONS, type Permission } from '@/lib/permissions';
import { groupedPermissions } from '@/lib/permission-groups';
import { createRole, deleteRole, updateRole } from '@/lib/staff';
import type { Role } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

// Computed once at module load, not per render: groupedPermissions() is pure
// over PERMISSIONS/PERMISSION_GROUPS, both module constants, so there is
// nothing about a particular modal open that could change its answer.
const GROUPED_PERMISSIONS = groupedPermissions();

// Role *definitions* only (what a role can do) -- roster management
// (adding/removing staff, assigning a role to someone) moved to the Team
// tab inside People (src/app/(admin)/(tabs)/people.tsx, see
// docs/superpowers/plans/2026-08-02-people-team-hr.md Task 12), a distinct
// admin concern from this one. Formerly StaffPanel; the removed
// StaffSection/StaffRow/AddStaffModal logic lives on in team-add-modal.tsx.

export function RolesPanel({
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
  return (
    <View>
      <PageHeader title="Roles" />
      <RolesSection shopId={shopId} roles={roles} usage={usage} onChange={onChange} />
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
      <Text style={styles.hint}>Define what each role can do, then assign staff to it from the Team tab.</Text>
      {roles.length === 0 ? (
        <Text style={styles.empty}>No roles yet — create one to start adding staff.</Text>
      ) : (
        roles.map((role) => (
          <Row key={role.id} label={role.name} desc={`${role.permissions.length} permission${role.permissions.length === 1 ? '' : 's'} · ${usage.get(role.id) ?? 0} staff`}>
            <Btn accessibilityLabel={`Edit ${role.name}`} onPress={() => setEditing(role)}>Edit</Btn>
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
  // Seeded through expandPermissions rather than the raw stored array, so a
  // role holding only a child (e.g. ['inventory.count']) resolves its parent
  // and grandparent into state too -- the on-screen switches start coherent
  // (parent checked, child checked-and-enabled) instead of showing a child
  // checked under a parent that reads off.
  const [permissions, setPermissions] = useState<string[]>(() => expandPermissions(role?.permissions ?? []));
  // Stored permission strings this client's catalogue doesn't recognize -- a
  // role saved by a client running a newer PERMISSIONS list than this one.
  // expandPermissions (used to seed `permissions` above, and again on save)
  // drops exactly these, by design, everywhere else it's used -- so they're
  // captured here, before that drop, and never touched by togglePermission.
  // Folded back into the payload only in save(), which is what stops an
  // admin who opens and saves this role untouched from silently demoting it.
  const [unknownPermissions, setUnknownPermissions] = useState<string[]>(() =>
    (role?.permissions ?? []).filter((p) => !(ALL_PERMISSIONS as string[]).includes(p))
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setName(role?.name ?? '');
      setPermissions(expandPermissions(role?.permissions ?? []));
      setUnknownPermissions((role?.permissions ?? []).filter((p) => !(ALL_PERMISSIONS as string[]).includes(p)));
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
      // unknownPermissions never entered `permissions`, so it can't collide
      // with anything expandPermissions resolves -- a plain concat carries
      // it through rather than expandPermissions silently dropping it again.
      await onSave({ name: trimmed, permissions: [...expandPermissions(permissions), ...unknownPermissions] });
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
    <AppModal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>{role ? 'Edit role' : 'New role'}</Text>
            <View style={modalStyles.headerActions}>
              <Pressable
                accessibilityLabel="Save role"
                onPress={save}
                disabled={saving || !name.trim()}
                style={[modalStyles.addButton, (saving || !name.trim()) && modalStyles.buttonDisabled]}
              >
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
            {GROUPED_PERMISSIONS.map((group) => (
              <View key={group.label}>
                <Text style={[modalStyles.fieldLabel, { marginTop: 16 }]}>{group.label.toUpperCase()}</Text>
                {group.rows.map(({ permission, children }) => (
                  <View key={permission.key}>
                    <PermissionRow
                      entry={permission}
                      checked={permissions.includes(permission.key)}
                      disabled={false}
                      onToggle={() => togglePermission(permission.key)}
                    />
                    {/* Indented and ruled, so a child reads as living INSIDE
                        the row above rather than beside it -- and disabled
                        when that row is off, because a child granted under an
                        absent parent is an array the database honours and the
                        screen denies. */}
                    {children.map((child) => (
                      <PermissionRow
                        key={child.key}
                        entry={child}
                        checked={permissions.includes(child.key)}
                        disabled={!permissions.includes(permission.key)}
                        onToggle={() => togglePermission(child.key)}
                        nested
                      />
                    ))}
                  </View>
                ))}
              </View>
            ))}
            {error && <Text style={styles.error}>{error}</Text>}
            <View style={modalStyles.formActions}>
              {onDelete && (
                <Pressable onPress={remove} disabled={saving} style={modalStyles.rowAction}>
                  <Text style={modalStyles.rowActionTextDanger}>Delete role</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityLabel="Save role"
                onPress={save}
                disabled={saving || !name.trim()}
                style={[modalStyles.addButton, (saving || !name.trim()) && modalStyles.buttonDisabled]}
              >
                <Text style={modalStyles.addButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

function PermissionRow({
  entry,
  checked,
  disabled,
  onToggle,
  nested,
}: {
  entry: { key: Permission; label: string; description: string };
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  nested?: boolean;
}) {
  return (
    <Pressable
      // The label, not the key: the tests and a screen reader both read the
      // sentence a shop reads.
      accessibilityLabel={`Permission: ${entry.label}`}
      accessibilityRole="switch"
      accessibilityState={{ checked, disabled }}
      // Guarded here as well as visually, and guarded INSIDE the handler
      // rather than by nulling the `onPress` prop -- a caller (a test, or a
      // screen reader that still dispatches an activation event to a
      // "disabled" node) that invokes it anyway must land on a no-op, not a
      // crash. A disabled row whose press still ran would switch the child on
      // under an off parent -- which is precisely the state the disabling
      // exists to prevent.
      onPress={() => {
        if (disabled) return;
        onToggle();
      }}
      // Native, in addition to the JS guard above: without this the row stays
      // in the tab/focus order and keeps receiving real taps that just no-op,
      // rather than reading as genuinely inert.
      disabled={disabled}
      style={[modalStyles.permissionRow, nested && modalStyles.permissionRowNested, disabled && modalStyles.permissionRowOff]}
    >
      <Switch value={checked} disabled={disabled} pointerEvents="none" onValueChange={() => {}} />
      <View style={{ flex: 1 }}>
        <Text style={modalStyles.rowLabel}>{entry.label}</Text>
        <Text style={modalStyles.rowSubLabel}>{entry.description}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  empty: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
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
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  permissionRowNested: { paddingLeft: 18, marginLeft: 2, borderLeftWidth: 2, borderLeftColor: '#F2F2F2' },
  permissionRowOff: { opacity: 0.45 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  rowSubLabel: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: '#CCCCCC' },
});
