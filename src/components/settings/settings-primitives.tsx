import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { Colors } from '@/constants/theme';

// Shared visual language for every Settings panel — RN port of the
// Section/Row/Btn/Toggle/Pill/Badge/PageHeader primitives from the approved
// design mock. Colors match the grayscale palette AdminSidebar and the rest
// of the admin chrome already use (not Colors.light's warm/green palette,
// which nothing in this part of the app uses) — `danger` is the one value
// that already lines up with a theme token, so it's pulled from there.
const gray = {
  text: '#111111',
  textSecondary: '#6B7280',
  textMuted: '#9CA3AF',
  border: '#E5E7EB',
  borderLight: '#F3F4F6',
  surfaceMuted: '#F9FAFB',
  danger: Colors.light.danger,
  dangerBorder: '#FECACA',
};

// `badge` is a separate prop (not folded into `title`/`label` as a ReactNode)
// because Badge renders a native `View` — nesting a View inside `Text` is
// invalid on native RN even though web tolerates it, so the badge has to be
// a sibling of the Text, not its child.
export function Section({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {badge}
      </View>
      {children}
    </View>
  );
}

export function Row({ label, badge, desc, children }: { label: string; badge?: React.ReactNode; desc?: string; children?: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <View style={styles.rowLabelWrap}>
          <Text style={styles.rowLabel}>{label}</Text>
          {badge}
        </View>
        {desc ? <Text style={styles.rowDesc}>{desc}</Text> : null}
      </View>
      {children ? <View style={styles.rowActions}>{children}</View> : null}
    </View>
  );
}

export function Btn({
  children,
  danger,
  onPress,
  disabled,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.btn, danger && styles.btnDanger, disabled && styles.btnDisabled, pressed && !disabled && styles.btnPressed]}
    >
      <Text style={[styles.btnText, danger && styles.btnTextDanger, disabled && styles.btnTextDisabled]}>{children}</Text>
    </Pressable>
  );
}

export function Toggle({ value, onValueChange, disabled }: { value: boolean; onValueChange?: (value: boolean) => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={() => !disabled && onValueChange?.(!value)}
      disabled={disabled}
      style={[styles.toggle, value && styles.toggleOn, disabled && styles.toggleDisabled]}
    >
      <View style={[styles.toggleThumb, value && styles.toggleThumbOn]} />
    </Pressable>
  );
}

export function Pill({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{children}</Text>
    </View>
  );
}

export function Badge({ children, variant = 'new' }: { children: React.ReactNode; variant?: 'new' | 'pro' }) {
  return (
    <View style={[styles.badge, variant === 'pro' && styles.badgePro]}>
      <Text style={[styles.badgeText, variant === 'pro' && styles.badgeTextPro]}>{children}</Text>
    </View>
  );
}

export function PageHeader({
  title,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <View style={styles.pageHeader}>
      <Text style={styles.pageTitle}>{title}</Text>
      {actionLabel ? (
        <Btn onPress={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Btn>
      ) : null}
    </View>
  );
}

// A Row whose value doubles as an editable field: starts as static
// label+value+Edit (matching the mock), and swaps to a TextInput in place
// when Edit is tapped. Persisting the change is still the owning panel's
// job (its existing dirty-check + Save button) — this only toggles what's
// rendered, so no new save pipeline is introduced per field.
export function EditableTextRow({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
  keyboardType,
  emptyText = 'Not set',
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: TextInputProps['keyboardType'];
  emptyText?: string;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <Row label={label} desc={value.trim() ? value : emptyText}>
        <Btn onPress={() => setEditing(true)}>Edit</Btn>
      </Row>
    );
  }

  return (
    <View style={styles.editingRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.editingInputRow}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={gray.textMuted}
          multiline={multiline}
          keyboardType={keyboardType}
          autoFocus
          style={[styles.input, multiline && styles.multilineInput]}
          textAlignVertical={multiline ? 'top' : undefined}
        />
        <Btn onPress={() => setEditing(false)}>Done</Btn>
      </View>
    </View>
  );
}

// A Row for a value that's shown but never edited here (e.g. account email).
export function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return <Row label={label} desc={value} />;
}

const styles = StyleSheet.create({
  section: { marginBottom: 28 },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: gray.border,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: gray.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: gray.borderLight,
    gap: 16,
  },
  rowText: { flex: 1 },
  rowLabelWrap: { flexDirection: 'row', alignItems: 'center' },
  rowLabel: { fontSize: 14, fontWeight: '600', color: gray.text },
  rowDesc: { fontSize: 12, color: gray.textSecondary, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 8, alignItems: 'center', flexShrink: 0 },

  btn: { paddingVertical: 6, paddingHorizontal: 13, borderRadius: 8, borderWidth: 1, borderColor: gray.border, backgroundColor: 'transparent' },
  btnDanger: { borderColor: gray.dangerBorder },
  btnDisabled: { opacity: 0.4 },
  btnPressed: { backgroundColor: gray.borderLight },
  btnText: { fontSize: 12, fontWeight: '700', color: gray.text },
  btnTextDanger: { color: gray.danger },
  btnTextDisabled: { color: gray.textMuted },

  toggle: { width: 42, height: 24, borderRadius: 20, backgroundColor: '#D1D5DB', padding: 3, justifyContent: 'center' },
  toggleOn: { backgroundColor: gray.text },
  toggleDisabled: { opacity: 0.5 },
  toggleThumb: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF' },
  toggleThumbOn: { marginLeft: 18 },

  pill: { paddingVertical: 4, paddingHorizontal: 11, borderRadius: 20, borderWidth: 1, borderColor: gray.border, backgroundColor: gray.surfaceMuted },
  pillText: { fontSize: 12, color: gray.textSecondary, fontWeight: '600' },

  badge: { paddingVertical: 2, paddingHorizontal: 9, borderRadius: 20, marginLeft: 6, backgroundColor: '#DCFCE7' },
  badgePro: { backgroundColor: '#EDE9FE' },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#166534' },
  badgeTextPro: { color: '#5B21B6' },

  pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12 },
  pageTitle: { fontSize: 21, fontWeight: '800', color: gray.text },

  editingRow: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: gray.borderLight, gap: 8 },
  editingInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { flex: 1, backgroundColor: gray.surfaceMuted, borderRadius: 10, height: 42, paddingHorizontal: 12, color: gray.text, borderWidth: 1, borderColor: gray.border },
  multilineInput: { height: 84, paddingTop: 11 },
});
