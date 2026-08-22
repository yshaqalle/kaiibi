import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { StorePicker } from '@/components/store-picker';
import { VendorPicker, type SelectedVendor } from '@/components/vendor-picker';
import { AppModal } from '@/components/ui/app-modal';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import {
  FIXED_ASSET_CATEGORIES,
  accumulatedDepreciationCents,
  monthsElapsed,
} from '@/lib/asset-depreciation';
import { formatAccountingCents, toCents } from '@/lib/currency';
import { createFixedAsset, deleteFixedAsset, updateFixedAsset } from '@/lib/fixed-assets';
import { toDateColumn } from '@/lib/period';
import type { FixedAsset, FixedAssetCategory } from '@/types/models';

const theme = Colors.light;

// Recording an asset, and retiring one.
//
// The preview at the bottom is the part worth keeping. Depreciation is the one
// idea in Accounting that people get wrong by not believing it -- "I paid
// $3,000, why does the report say $2,450" -- and showing the monthly charge and
// today's book value while the form is still open answers the question before
// it is asked. It also catches a mistyped life: 6 months on a delivery bike
// prints a monthly charge that is obviously absurd.

// Common lives, in months, as a shop thinks of them. A free-typed number is
// still allowed -- these are just the ones nobody should have to work out.
const LIFE_PRESETS: { label: string; months: number }[] = [
  { label: '1 year', months: 12 },
  { label: '3 years', months: 36 },
  { label: '5 years', months: 60 },
  { label: '10 years', months: 120 },
];

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function FixedAssetModal({
  asset,
  onClose,
  onSaved,
}: {
  asset: FixedAsset | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { shop } = useAuth();
  const [name, setName] = useState(asset?.name ?? '');
  const [category, setCategory] = useState<FixedAssetCategory>(asset?.category ?? 'equipment');
  const [acquiredOn, setAcquiredOn] = useState(asset?.acquiredOn ?? toDateColumn(new Date()));
  const [cost, setCost] = useState(asset ? (asset.costCents / 100).toFixed(2) : '');
  const [salvage, setSalvage] = useState(asset && asset.salvageValueCents > 0 ? (asset.salvageValueCents / 100).toFixed(2) : '');
  const [life, setLife] = useState(String(asset?.usefulLifeMonths ?? 60));
  const [vendor, setVendor] = useState<SelectedVendor | null>(
    asset?.vendorId ? { id: asset.vendorId, name: asset.vendorName ?? 'Vendor' } : null
  );
  const [reference, setReference] = useState(asset?.reference ?? '');
  const [notes, setNotes] = useState(asset?.notes ?? '');
  const [locationId, setLocationId] = useState<string | null>(asset?.locationId ?? null);
  const [disposing, setDisposing] = useState(false);
  const [disposedOn, setDisposedOn] = useState(toDateColumn(new Date()));
  const [proceeds, setProceeds] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const costCents = cost.trim() === '' ? 0 : toCents(cost);
  const salvageCents = salvage.trim() === '' ? 0 : toCents(salvage);
  const lifeMonths = Number.parseInt(life, 10);
  const lifeValid = Number.isFinite(lifeMonths) && lifeMonths > 0;
  const acquiredValid = parseDateInput(acquiredOn) !== null;
  const salvageValid = salvageCents <= costCents;
  const canSave = name.trim().length > 0 && costCents > 0 && lifeValid && acquiredValid && salvageValid && !saving;

  // Built from the form's own values, not from the saved row, so it moves as
  // the reader types.
  const preview = useMemo(() => {
    if (costCents <= 0 || !lifeValid || !acquiredValid) return null;
    const draft: FixedAsset = {
      id: asset?.id ?? 'preview',
      shopId: shop?.id ?? '',
      locationId,
      name: name.trim(),
      category,
      acquiredOn,
      costCents,
      salvageValueCents: salvageValid ? salvageCents : 0,
      usefulLifeMonths: lifeMonths,
      vendorId: vendor?.id ?? null,
      vendorName: vendor?.name ?? null,
      reference: null,
      notes: null,
      disposedOn: null,
      disposalProceedsCents: null,
      createdAt: '',
      updatedAt: '',
    };
    const today = toDateColumn(new Date());
    const accumulated = accumulatedDepreciationCents(draft, today);
    return {
      monthlyCents: Math.round((costCents - (salvageValid ? salvageCents : 0)) / lifeMonths),
      accumulated,
      bookValue: costCents - accumulated,
      monthsUsed: monthsElapsed(acquiredOn, today, lifeMonths),
    };
  }, [asset?.id, shop?.id, locationId, name, category, acquiredOn, costCents, salvageCents, salvageValid, lifeMonths, lifeValid, acquiredValid, vendor]);

  const save = async () => {
    if (!canSave || !shop) return;
    setSaving(true);
    setError(null);
    try {
      const input = {
        locationId,
        name: name.trim(),
        category,
        acquiredOn,
        costCents,
        salvageValueCents: salvageCents,
        usefulLifeMonths: lifeMonths,
        vendorId: vendor?.id ?? null,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
        disposedOn: asset?.disposedOn ?? null,
        disposalProceedsCents: asset?.disposalProceedsCents ?? null,
      };
      if (asset) await updateFixedAsset(asset.id, input);
      else await createFixedAsset(shop.id, input);
      await onSaved();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this asset.'));
      setSaving(false);
    }
  };

  const dispose = async () => {
    if (!asset) return;
    setSaving(true);
    setError(null);
    try {
      // Zero, not null, when nothing was typed: "scrapped for nothing" and
      // "nobody said what it fetched" are different facts, and the gain or loss
      // depends on which it was.
      await updateFixedAsset(asset.id, {
        disposedOn,
        disposalProceedsCents: proceeds.trim() === '' ? 0 : toCents(proceeds),
      });
      await onSaved();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not record this disposal.'));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!asset) return;
    setSaving(true);
    setError(null);
    try {
      await deleteFixedAsset(asset.id);
      await onSaved();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not delete this asset.'));
      setSaving(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{asset ? 'Edit asset' : 'New asset'}</Text>
            <View style={styles.headerActions}>
              <Pressable onPress={save} disabled={!canSave} style={[styles.primaryButton, !canSave && styles.buttonDisabled]}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView style={styles.body}>
            <Text style={styles.fieldLabel}>WHAT IS IT</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Display fridge"
              placeholderTextColor={theme.bentoMuted2}
              style={styles.input}
            />

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>KIND</Text>
            <View style={styles.chipRow}>
              {FIXED_ASSET_CATEGORIES.map((option) => {
                const active = option.key === category;
                return (
                  <Pressable key={option.key} onPress={() => setCategory(option.key)} style={[styles.chip, active && styles.chipActive]}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>BOUGHT ON</Text>
                <DateInput value={acquiredOn} onChangeText={setAcquiredOn} />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>COST</Text>
                <TextInput
                  value={cost}
                  onChangeText={setCost}
                  placeholder="0.00"
                  placeholderTextColor={theme.bentoMuted2}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
              </View>
            </View>

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>USEFUL LIFE (MONTHS)</Text>
                <TextInput
                  value={life}
                  onChangeText={setLife}
                  placeholder="60"
                  placeholderTextColor={theme.bentoMuted2}
                  keyboardType="number-pad"
                  style={styles.input}
                />
                <View style={styles.presetRow}>
                  {LIFE_PRESETS.map((preset) => (
                    <Pressable key={preset.months} onPress={() => setLife(String(preset.months))} style={styles.presetChip}>
                      <Text style={styles.presetText}>{preset.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <View style={styles.fieldHalf}>
                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>WORTH AT THE END</Text>
                <TextInput
                  value={salvage}
                  onChangeText={setSalvage}
                  placeholder="0.00"
                  placeholderTextColor={theme.bentoMuted2}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />
                <Text style={styles.hint}>Leave blank for anything that will be worth nothing.</Text>
              </View>
            </View>
            {!salvageValid ? <Text style={styles.error}>What it will be worth at the end cannot be more than it cost.</Text> : null}

            <View style={styles.storeBlock}>
              <StorePicker value={locationId} onChange={setLocationId} />
            </View>

            {shop && (
              <View style={styles.vendorBlock}>
                <VendorPicker shopId={shop.id} selected={vendor} onSelect={setVendor} onClear={() => setVendor(null)} />
              </View>
            )}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>REFERENCE</Text>
            <TextInput
              value={reference}
              onChangeText={setReference}
              placeholder="Invoice or serial number"
              placeholderTextColor={theme.bentoMuted2}
              style={styles.input}
            />

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>NOTE</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Anything worth remembering about it"
              placeholderTextColor={theme.bentoMuted2}
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.multiline]}
            />

            {preview && (
              <View style={styles.preview}>
                <Text style={styles.previewTitle}>What this will report</Text>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>Charged to profit each month</Text>
                  <Text style={styles.previewValue}>{formatAccountingCents(preview.monthlyCents)}</Text>
                </View>
                <View style={styles.previewRow}>
                  <Text style={styles.previewLabel}>{`Worn down after ${preview.monthsUsed} month${preview.monthsUsed === 1 ? '' : 's'}`}</Text>
                  <Text style={styles.previewValue}>{formatAccountingCents(preview.accumulated)}</Text>
                </View>
                <View style={[styles.previewRow, styles.previewRowLast]}>
                  <Text style={styles.previewLabelStrong}>Worth today</Text>
                  <Text style={styles.previewValueStrong}>{formatAccountingCents(preview.bookValue)}</Text>
                </View>
              </View>
            )}

            {asset && !asset.disposedOn && (
              <View style={styles.disposeBlock}>
                {disposing ? (
                  <>
                    <Text style={styles.fieldLabel}>SOLD, SCRAPPED OR WRITTEN OFF ON</Text>
                    <DateInput value={disposedOn} onChangeText={setDisposedOn} />
                    <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>WHAT IT FETCHED</Text>
                    <TextInput
                      value={proceeds}
                      onChangeText={setProceeds}
                      placeholder="0.00"
                      placeholderTextColor={theme.bentoMuted2}
                      keyboardType="decimal-pad"
                      style={styles.input}
                    />
                    <Text style={styles.hint}>
                      The difference between this and what it was still worth becomes the period&apos;s gain or loss.
                      Depreciation stops on the date above.
                    </Text>
                    <View style={styles.disposeActions}>
                      <Pressable onPress={dispose} disabled={saving} style={styles.primaryButton}>
                        <Text style={styles.primaryButtonText}>{saving ? 'Recording…' : 'Record disposal'}</Text>
                      </Pressable>
                      <Pressable onPress={() => setDisposing(false)} disabled={saving}>
                        <Text style={styles.mutedText}>Cancel</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <Pressable onPress={() => setDisposing(true)}>
                    <Text style={styles.disposeLink}>Sold, scrapped or written off?</Text>
                  </Pressable>
                )}
              </View>
            )}

            {asset?.disposedOn ? (
              <Text style={styles.hint}>
                {`Disposed of on ${asset.disposedOn}${
                  asset.disposalProceedsCents ? ` for ${formatAccountingCents(asset.disposalProceedsCents)}` : ''
                }. It no longer counts towards what the shop owns.`}
              </Text>
            ) : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.formActions}>
              {asset ? (
                confirmingDelete ? (
                  <View style={styles.confirmRow}>
                    <Text style={styles.confirmText}>Delete this asset?</Text>
                    <Pressable onPress={remove} disabled={saving}><Text style={styles.dangerText}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving}><Text style={styles.mutedText}>Cancel</Text></Pressable>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving}>
                    <Text style={styles.dangerText}>Delete asset</Text>
                  </Pressable>
                )
              ) : (
                <View />
              )}
              <Pressable onPress={save} disabled={!canSave} style={[styles.primaryButton, !canSave && styles.buttonDisabled]}>
                <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: theme.bentoSurface, borderRadius: 18, padding: 20, width: '100%', maxWidth: 600, maxHeight: '90%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: theme.bentoInk },
  close: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: theme.bentoSurface },
  body: { flexGrow: 0 },

  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6 },
  fieldLabelSpaced: { marginTop: 16 },
  input: { backgroundColor: theme.bentoSoft, borderRadius: 10, height: 42, paddingHorizontal: 12, color: theme.bentoInk },
  multiline: { height: 70, paddingTop: 11 },
  hint: { fontSize: 11, color: theme.bentoMuted, marginTop: 8, lineHeight: 16 },
  storeBlock: { marginTop: 16 },
  vendorBlock: { marginTop: 16 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  chipText: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted },
  chipTextActive: { color: theme.bentoSurface },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  presetChip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999 },
  presetText: { fontSize: 11, fontWeight: '700', color: theme.bentoMuted },

  preview: { marginTop: 20, backgroundColor: theme.bentoSoft, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 6 },
  previewTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: theme.bentoMuted, marginTop: 10, marginBottom: 4 },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  previewRowLast: { borderBottomWidth: 0 },
  previewLabel: { fontSize: 12.5, color: theme.bentoMuted, flex: 1, minWidth: 0 },
  previewLabelStrong: { fontSize: 13, fontWeight: '800', color: theme.bentoInk, flex: 1, minWidth: 0 },
  previewValue: { fontSize: 13, fontWeight: '700', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  previewValueStrong: { fontSize: 15, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },

  disposeBlock: { marginTop: 20, borderTopWidth: 1, borderTopColor: theme.bentoLine, paddingTop: 16 },
  disposeLink: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted },
  disposeActions: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },

  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginTop: 12 },
  formActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 20 },
  confirmRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  confirmText: { fontSize: 12, fontWeight: '600', color: theme.bentoInk },
  dangerText: { fontSize: 12, fontWeight: '700', color: theme.bentoLoss },
  mutedText: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted },
  primaryButton: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  primaryButtonText: { color: theme.bentoSurface, fontWeight: '800', fontSize: 13 },
  buttonDisabled: { backgroundColor: theme.bentoMuted2 },
});
