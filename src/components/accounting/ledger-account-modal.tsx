import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput, parseDateInput } from '@/components/date-input';
import { AppModal } from '@/components/ui/app-modal';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import {
  LEDGER_ACCOUNT_TYPES,
  feedBlurb,
  subtypeLabel,
  subtypesForType,
  suggestAccountCode,
} from '@/lib/chart-of-accounts';
import { toCents } from '@/lib/currency';
import { createLedgerAccount, deleteLedgerAccount, updateLedgerAccount } from '@/lib/ledger';
import { toDateColumn } from '@/lib/period';
import type { LedgerAccount, LedgerAccountSubtype, LedgerAccountType } from '@/types/models';

const theme = Colors.light;

// One modal for adding and editing an account. Mounted only while editing and
// keyed by account id, so the fields initialise from props and never need an
// effect to resync -- the shape every other editor on this screen uses.
//
// Three things are deliberately not editable, and each would break something
// if it were:
//
//   `feed`     decides how the account is READ. Repointing it restates every
//              statement the account has ever appeared on, silently.
//   `contra`   decides which way it prints. Same problem, smaller blast radius.
//   the type   of a SEEDED account, for the same reason -- '1000' being an
//              asset is what the feed behind it assumes.
//
// A shop that needs a different arrangement archives the account and makes a
// new one, which leaves the old statements saying what they always said.

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

export function LedgerAccountModal({
  account,
  existing,
  onClose,
  onSaved,
}: {
  account: LedgerAccount | null;
  /** The rest of the chart — for the duplicate-code check and the code suggestion. */
  existing: LedgerAccount[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const { shop } = useAuth();
  const [type, setType] = useState<LedgerAccountType>(account?.type ?? 'expense');
  const [subtype, setSubtype] = useState<LedgerAccountSubtype>(account?.subtype ?? 'operating_expense');
  const [code, setCode] = useState(account?.code ?? suggestAccountCode(existing, 'expense'));
  const [name, setName] = useState(account?.name ?? '');
  const [opening, setOpening] = useState(
    account && account.openingBalanceCents !== 0 ? (account.openingBalanceCents / 100).toFixed(2) : ''
  );
  const [openingOn, setOpeningOn] = useState(account?.openingBalanceOn ?? toDateColumn(new Date()));
  const [notes, setNotes] = useState(account?.notes ?? '');
  const [archived, setArchived] = useState(account?.archived ?? false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fed account's balance comes from elsewhere entirely, so the opening
  // field is not merely disabled — it is absent, and the sentence explaining
  // what fills the account stands in its place. A greyed-out box invites
  // someone to work out how to un-grey it.
  const isFed = account?.feed != null;
  // The type of a seeded account is load-bearing (see the header); a
  // shop-created one has no feed behind it and can be re-filed freely.
  const typeLocked = account !== null && account.isSystem;

  const trimmedCode = code.trim();
  const duplicate = existing.some((other) => other.id !== account?.id && other.code.trim() === trimmedCode);
  const openingCents = opening.trim() === '' ? 0 : toCents(opening);
  const openingDateValid = openingCents === 0 || parseDateInput(openingOn) !== null;
  const canSave = trimmedCode.length > 0 && name.trim().length > 0 && !duplicate && openingDateValid && !saving;

  const pickType = (next: LedgerAccountType) => {
    setType(next);
    // The subtype has to follow: 'operating_expense' under an income account
    // is a combination the database rejects, and a form that lets someone
    // build it only to be refused on save is a form that wasted their time.
    setSubtype(subtypesForType(next)[0]);
    if (!account) setCode(suggestAccountCode(existing, next));
  };

  const save = async () => {
    if (!canSave || !shop) return;
    setSaving(true);
    setError(null);
    try {
      const patch = {
        code: trimmedCode,
        name: name.trim(),
        type,
        subtype,
        // Never written for a fed account: the database refuses the
        // combination, and sending a zero it would accept is still a lie about
        // what the form asked.
        openingBalanceCents: isFed ? 0 : openingCents,
        openingBalanceOn: isFed || openingCents === 0 ? null : openingOn,
        notes: notes.trim() || null,
      };
      if (account) await updateLedgerAccount(account.id, { ...patch, archived });
      else await createLedgerAccount(shop.id, patch);
      await onSaved();
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not save this account.'));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!account) return;
    setSaving(true);
    setError(null);
    try {
      await deleteLedgerAccount(account.id);
      await onSaved();
    } catch (err) {
      // The two refusals this can hit both have a fix the reader can act on,
      // and neither is worth pre-checking (see deleteLedgerAccount).
      setError(
        extractErrorMessage(
          err,
          'Could not delete this account. An account with journal entries against it can be archived instead.'
        )
      );
      setSaving(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{account ? 'Edit account' : 'New account'}</Text>
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
            {isFed && account?.feed ? (
              <View style={styles.fedBanner}>
                <Text style={styles.fedTitle}>This account reports itself</Text>
                <Text style={styles.fedBody}>{feedBlurb(account.feed)}</Text>
                <Text style={styles.fedBody}>
                  Its balance cannot be typed in or posted to — rename it or renumber it to suit your books, and the
                  figure keeps coming from where it comes from.
                </Text>
              </View>
            ) : null}

            <View style={styles.fieldRow}>
              <View style={styles.fieldNarrow}>
                <Text style={styles.fieldLabel}>CODE</Text>
                <TextInput value={code} onChangeText={setCode} placeholder="6000" placeholderTextColor={theme.bentoMuted2} style={styles.input} />
              </View>
              <View style={styles.fieldWide}>
                <Text style={styles.fieldLabel}>NAME</Text>
                <TextInput value={name} onChangeText={setName} placeholder="Bank charges" placeholderTextColor={theme.bentoMuted2} style={styles.input} />
              </View>
            </View>
            {duplicate ? <Text style={styles.error}>{`Another account already uses code ${trimmedCode}.`}</Text> : null}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>TYPE</Text>
            <View style={styles.chipRow}>
              {LEDGER_ACCOUNT_TYPES.map((option) => {
                const active = option.key === type;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => !typeLocked && pickType(option.key)}
                    disabled={typeLocked}
                    style={[styles.chip, active && styles.chipActive, typeLocked && !active && styles.chipMuted]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            {typeLocked ? (
              <Text style={styles.hint}>
                A built-in account keeps its type — the figures that report into it depend on it. Archive it and add
                your own if you need a different arrangement.
              </Text>
            ) : (
              <Text style={styles.hint}>{LEDGER_ACCOUNT_TYPES.find((t) => t.key === type)?.blurb}</Text>
            )}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>WHERE IT PRINTS</Text>
            <View style={styles.chipRow}>
              {subtypesForType(type).map((option) => {
                const active = option === subtype;
                return (
                  <Pressable
                    key={option}
                    onPress={() => !typeLocked && setSubtype(option)}
                    disabled={typeLocked}
                    style={[styles.chip, active && styles.chipActive, typeLocked && !active && styles.chipMuted]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{subtypeLabel(option)}</Text>
                  </Pressable>
                );
              })}
            </View>

            {!isFed && (
              <>
                <View style={styles.fieldRow}>
                  <View style={styles.fieldHalf}>
                    <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>OPENING BALANCE</Text>
                    <TextInput
                      value={opening}
                      onChangeText={setOpening}
                      placeholder="0.00"
                      placeholderTextColor={theme.bentoMuted2}
                      keyboardType="decimal-pad"
                      style={styles.input}
                    />
                  </View>
                  {openingCents !== 0 && (
                    <View style={styles.fieldHalf}>
                      <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>AS AT</Text>
                      <DateInput value={openingOn} onChangeText={setOpeningOn} />
                    </View>
                  )}
                </View>
                <Text style={styles.hint}>
                  What this account already held when you started keeping books here — capital you put in, a loan
                  still owed, profit kept from before. Leave it blank if the books start at zero.
                </Text>
              </>
            )}

            <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>NOTE</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="What belongs in this account?"
              placeholderTextColor={theme.bentoMuted2}
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.multiline]}
            />

            {account && (
              <Pressable onPress={() => setArchived((on) => !on)} style={styles.toggleRow}>
                <View style={[styles.toggleBox, archived && styles.toggleBoxOn]}>
                  {archived ? <Text style={styles.toggleTick}>✓</Text> : null}
                </View>
                <View style={styles.toggleTextWrap}>
                  <Text style={styles.toggleLabel}>Archived</Text>
                  <Text style={styles.hint}>
                    Kept, with its history, but out of the pickers and out of any statement where it is zero.
                  </Text>
                </View>
              </Pressable>
            )}

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.formActions}>
              {account && !account.isSystem ? (
                confirmingDelete ? (
                  <View style={styles.confirmRow}>
                    <Text style={styles.confirmText}>Delete this account?</Text>
                    <Pressable onPress={remove} disabled={saving}><Text style={styles.dangerText}>Confirm</Text></Pressable>
                    <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving}><Text style={styles.mutedText}>Cancel</Text></Pressable>
                  </View>
                ) : (
                  <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving}>
                    <Text style={styles.dangerText}>Delete account</Text>
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
  card: { backgroundColor: theme.bentoSurface, borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '88%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: theme.bentoInk },
  close: { backgroundColor: theme.bentoInk, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: theme.bentoSurface },
  body: { flexGrow: 0 },

  fedBanner: { backgroundColor: theme.bentoSoft, borderRadius: 14, padding: 14, marginBottom: 16, gap: 6 },
  fedTitle: { fontSize: 13, fontWeight: '800', color: theme.bentoInk },
  fedBody: { fontSize: 12, color: theme.bentoMuted, lineHeight: 17 },

  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldNarrow: { flexBasis: 110, flexGrow: 0 },
  fieldWide: { flex: 1 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6 },
  fieldLabelSpaced: { marginTop: 16 },
  input: { backgroundColor: theme.bentoSoft, borderRadius: 10, height: 42, paddingHorizontal: 12, color: theme.bentoInk },
  multiline: { height: 70, paddingTop: 11 },
  hint: { fontSize: 11, color: theme.bentoMuted, marginTop: 8, lineHeight: 16 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: theme.bentoLine, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999 },
  chipActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  chipMuted: { opacity: 0.4 },
  chipText: { fontSize: 12, fontWeight: '700', color: theme.bentoMuted },
  chipTextActive: { color: theme.bentoSurface },

  toggleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 18 },
  toggleBox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1, borderColor: theme.bentoLine, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  toggleBoxOn: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  toggleTick: { color: theme.bentoSurface, fontSize: 12, fontWeight: '900' },
  toggleTextWrap: { flex: 1, minWidth: 0 },
  toggleLabel: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },

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
