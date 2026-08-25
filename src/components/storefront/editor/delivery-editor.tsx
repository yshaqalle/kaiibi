import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { formatCents, toCents } from '@/lib/currency';
import type { DeliveryArea } from '@/lib/storefront-admin';

// Pinned to the light palette -- no dark mode yet, same as every other bento
// screen.
const theme = Colors.light;

// Deliberately free of every data-layer import (no lib/storefront-admin's
// functions, no lib/supabase): only the DeliveryArea SHAPE comes from that
// module, as a type-only import that is erased at compile time. The caller
// owns listing, saving and deleting areas -- this component only renders
// what those results mean to a shopkeeper and hands typed input back up
// through onToggle/onSave/onDelete, the same seam ContentDrawer uses.
export type SavedArea = { id?: string; name: string; feeCents: number; sortOrder: number };

export function DeliveryEditor({
  offersDelivery,
  areas,
  onToggle,
  onSave,
  onDelete,
}: {
  offersDelivery: boolean;
  areas: DeliveryArea[];
  onToggle: (value: boolean) => void;
  // Both write straight to the live page, not to the draft (B4's own
  // caveat text below explains why to the shopkeeper) -- so a rejection
  // here (most likely the `unique (shop_id, name)` constraint,
  // 20260924000000, which storefront-admin.ts deliberately lets surface
  // rather than pre-checking) is a real failure the row silently never
  // appearing would otherwise hide. Typed to return a promise specifically
  // so nothing downstream can drop it the way a bare `void` return once let
  // happen -- both are awaited below, and a rejection is always routed into
  // `error`, never left as an unhandled promise.
  onSave: (area: SavedArea) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  // Focused by the "no areas" caveat's action -- see the comment above that
  // Caveat below for why a `wrong` tone needs a real fix, not just a sentence.
  const addNameRef = useRef<TextInput>(null);
  const sorted = [...areas].sort((a, b) => a.sortOrder - b.sortOrder);
  const [error, setError] = useState<string | null>(null);

  // Wraps the caller's onSave: awaits it (the actual fix -- AreaRow and
  // AddAreaRow used to fire this and move on, dropping the promise and with
  // it any rejection) and reports success back so the row calling it knows
  // whether to leave edit mode. `false` means the shopkeeper is still
  // looking at exactly what they typed, with a reason it didn't take.
  async function handleSave(area: SavedArea): Promise<boolean> {
    setError(null);
    try {
      await onSave(area);
      return true;
    } catch {
      setError('Could not save this delivery area — a name here may already be taken, or something went wrong. Try again.');
      return false;
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setError(null);
    try {
      await onDelete(id);
    } catch {
      setError('Could not remove this delivery area. Try again.');
    }
  }

  return (
    <BentoCard title="Delivery">
      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <Text style={styles.toggleLabel}>Deliver to customers</Text>
          <Text style={styles.toggleHint}>
            {offersDelivery ? 'Customers can ask for delivery at checkout.' : 'Checkout is collection-only.'}
          </Text>
        </View>
        <Switch
          testID="delivery-editor-toggle"
          value={offersDelivery}
          onValueChange={onToggle}
          trackColor={{ false: theme.bentoLine, true: theme.bentoInk }}
          thumbColor={theme.bentoSurface}
          ios_backgroundColor={theme.bentoLine}
        />
      </View>

      {error ? (
        <Caveat tone="wrong" onDismiss={() => setError(null)}>
          {error}
        </Caveat>
      ) : null}

      {/* Property 1: delivery OFF renders no area fields at all -- not a
          disabled list, which would suggest delivery is available when it
          is not. Nothing below this point mounts unless offersDelivery. */}
      {offersDelivery ? (
        <>
          {sorted.length === 0 ? (
            // Property 5: delivery ON with nowhere to deliver to is a WRONG
            // state -- it produces a checkout that offers delivery to
            // nowhere -- so it gets a `wrong` caveat that names its fix and
            // jumps the shopkeeper straight to the field that fixes it.
            <Caveat tone="wrong" action={{ label: 'Add a delivery area', onPress: () => addNameRef.current?.focus() }}>
              Delivery is on but no areas are listed yet — add at least one area so checkout has somewhere to offer.
            </Caveat>
          ) : (
            <View style={styles.list}>
              {sorted.map((area) => (
                <AreaRow key={area.id} area={area} onSave={handleSave} onDelete={handleDelete} />
              ))}
            </View>
          )}

          <AddAreaRow nextSortOrder={sorted.length} onSave={handleSave} nameInputRef={addNameRef} />
        </>
      ) : null}
    </BentoCard>
  );
}

// A single delivery area. View mode shows the committed name and fee as
// plain text -- Property 2: a $0.00 fee must READ as free, not blank, so it
// is always rendered through formatCents, never omitted for being zero. Edit
// mode swaps in draft inputs that only reach onSave once "Save" is pressed,
// so a half-typed name or fee never overwrites what is actually stored.
function AreaRow({
  area,
  onSave,
  onDelete,
}: {
  area: DeliveryArea;
  onSave: (area: SavedArea) => Promise<boolean>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(area.name);
  const [draftFee, setDraftFee] = useState((area.feeCents / 100).toFixed(2));

  function startEdit() {
    setDraftName(area.name);
    setDraftFee((area.feeCents / 100).toFixed(2));
    setEditing(true);
  }

  async function commit() {
    const name = draftName.trim();
    if (!name) {
      // Nothing usable typed -- drop back to the last saved name rather
      // than saving a blank one.
      setDraftName(area.name);
      setEditing(false);
      return;
    }
    // Property 3: toCents is the only path a fee reaches feeCents through --
    // it clamps anything with a "-" in it to 0, so a negative number cannot
    // be saved regardless of what was typed, on top of the "-" filter on the
    // input itself below.
    const saved = await onSave({ id: area.id, name, feeCents: toCents(draftFee), sortOrder: area.sortOrder });
    // A failed save (B4) leaves editing open, showing exactly what the
    // shopkeeper typed, rather than closing the row on a write that never
    // actually landed.
    if (saved) setEditing(false);
  }

  if (editing) {
    return (
      <View style={styles.row} testID={`delivery-editor-row-${area.id}`}>
        <TextInput
          testID={`delivery-editor-name-input-${area.id}`}
          style={styles.nameInput}
          value={draftName}
          onChangeText={setDraftName}
          placeholder="Area name"
        />
        <TextInput
          testID={`delivery-editor-fee-input-${area.id}`}
          style={styles.feeInput}
          value={draftFee}
          onChangeText={(text) => setDraftFee(text.replace(/-/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0.00"
        />
        <Pressable testID={`delivery-editor-save-${area.id}`} onPress={commit} style={styles.smallButton}>
          <Text style={styles.smallButtonText}>Save</Text>
        </Pressable>
        <Pressable onPress={() => setEditing(false)} style={styles.smallButtonGhost}>
          <Text style={styles.smallButtonGhostText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.row} testID={`delivery-editor-row-${area.id}`}>
      <View style={styles.rowText}>
        <Text style={styles.areaName}>{area.name}</Text>
        <Text style={styles.areaFee}>{formatCents(area.feeCents)}</Text>
      </View>
      <Pressable testID={`delivery-editor-edit-${area.id}`} onPress={startEdit} style={styles.smallButtonGhost}>
        <Text style={styles.smallButtonGhostText}>Edit</Text>
      </Pressable>
      <Pressable testID={`delivery-editor-delete-${area.id}`} onPress={() => onDelete(area.id)} style={styles.smallButtonGhost}>
        <Text style={styles.smallButtonGhostText}>Remove</Text>
      </Pressable>
    </View>
  );
}

// The row that adds a new area. Stays mounted whenever delivery is on, areas
// or none -- it is the actual fix the "no areas" caveat above points at, not
// just words describing one.
function AddAreaRow({
  nextSortOrder,
  onSave,
  nameInputRef,
}: {
  nextSortOrder: number;
  onSave: (area: SavedArea) => Promise<boolean>;
  nameInputRef: React.RefObject<TextInput | null>;
}) {
  const [name, setName] = useState('');
  const [fee, setFee] = useState('');

  async function commit() {
    const trimmed = name.trim();
    if (!trimmed) return; // Nothing typed -- there is no area to add yet.
    const saved = await onSave({ name: trimmed, feeCents: toCents(fee), sortOrder: nextSortOrder });
    // A failed save (B4) leaves what was typed in place, rather than
    // clearing fields for a row that never actually got added.
    if (saved) {
      setName('');
      setFee('');
    }
  }

  const disabled = !name.trim();

  return (
    <View style={styles.addRow}>
      <Text style={[styles.eyebrow, styles.spaced]}>Add a delivery area</Text>
      <View style={styles.addFields}>
        <TextInput
          ref={nameInputRef}
          testID="delivery-editor-add-name"
          style={[styles.nameInput, styles.addInput]}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Outside town"
        />
        <TextInput
          testID="delivery-editor-add-fee"
          style={[styles.feeInput, styles.addInput]}
          value={fee}
          onChangeText={(text) => setFee(text.replace(/-/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0.00"
        />
      </View>
      <Pressable
        testID="delivery-editor-add-button"
        disabled={disabled}
        onPress={commit}
        style={[styles.addButton, disabled && styles.addButtonDisabled]}
      >
        <Text style={styles.addButtonText}>Add area</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  toggleText: { flex: 1 },
  toggleLabel: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  toggleHint: { fontSize: 12, color: theme.bentoMuted2, marginTop: 2 },

  list: { marginTop: 14, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  rowText: { flex: 1, minWidth: 0 },
  areaName: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  areaFee: { fontSize: 12.5, fontWeight: '600', color: theme.bentoMuted2, marginTop: 2 },

  smallButton: {
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  smallButtonText: { fontSize: 12, fontWeight: '800', color: theme.bentoSurface },
  smallButtonGhost: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  smallButtonGhostText: { fontSize: 12, fontWeight: '700', color: theme.bentoInk },

  eyebrow: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
    marginBottom: 8,
  },
  spaced: { marginTop: 16 },

  addRow: { marginTop: 8 },
  addFields: { flexDirection: 'row', gap: 8 },
  addInput: { flex: 1 },
  nameInput: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13.5,
    color: theme.bentoInk,
  },
  feeInput: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSoft,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13.5,
    color: theme.bentoInk,
    width: 90,
  },

  addButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  addButtonDisabled: { opacity: 0.4 },
  addButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoSurface },
});
