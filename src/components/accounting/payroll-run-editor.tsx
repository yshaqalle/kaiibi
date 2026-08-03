import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Badge } from '@/components/badge';
import { formatAccountingCents, toCents } from '@/lib/currency';
import type { PayrollRun, PayrollRunLine } from '@/types/models';

// Review-and-commit screen for one pay run. Every line's amount stays editable
// until the run is posted -- that's what makes proration, bonuses, deductions
// and corrections workable without modelling each case separately.
export function PayrollRunEditor({
  run,
  onClose,
  onChangeLine,
  onPost,
  onUnpost,
  onDelete,
}: {
  run: PayrollRun;
  onClose: () => void;
  onChangeLine: (lineId: string, amountCents: number) => Promise<void>;
  onPost: () => Promise<void>;
  onUnpost: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const posted = run.status === 'posted';
  const lines = run.lines ?? [];
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);

  const run_ = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(extractErrorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerMain}>
              <Text style={styles.title}>{run.periodStart} to {run.periodEnd}</Text>
              <Badge label={posted ? 'Posted' : 'Draft'} tone={posted ? 'success' : 'default'} />
            </View>
            <Pressable onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body}>
            {lines.length === 0 ? (
              <Text style={styles.empty}>No staff to pay in this period.</Text>
            ) : (
              lines.map((line) => (
                <PayrollLineRow
                  key={line.id}
                  line={line}
                  editable={!posted && !busy}
                  onCommit={(amountCents) => run_(() => onChangeLine(line.id, amountCents), 'Could not update this line.')}
                />
              ))
            )}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total to pay</Text>
              <Text style={styles.totalValue}>{formatAccountingCents(total)}</Text>
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            {posted ? (
              <>
                <Text style={styles.note}>
                  Posted — this run has been added to expenses dated {run.periodEnd}, so it counts against that period&apos;s
                  profit. To correct it, unpost, adjust, and post again.
                </Text>
                <Pressable
                  onPress={() => run_(onUnpost, 'Could not unpost this run.')}
                  disabled={busy}
                  style={[styles.secondaryButton, busy && styles.buttonDisabled]}
                >
                  <Text style={styles.secondaryButtonText}>{busy ? 'Working…' : 'Unpost'}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.note}>
                  Posting adds {formatAccountingCents(total)} to expenses dated {run.periodEnd}. A period can only be posted
                  once.
                </Text>
                <Pressable
                  onPress={() => run_(onPost, 'Could not post this run.')}
                  disabled={busy || total <= 0}
                  style={[styles.primaryButton, (busy || total <= 0) && styles.buttonDisabled]}
                >
                  <Text style={styles.primaryButtonText}>{busy ? 'Posting…' : 'Post pay run'}</Text>
                </Pressable>
                <View style={styles.deleteRow}>
                  {confirmingDelete ? (
                    <>
                      <Text style={styles.confirmText}>Discard this draft?</Text>
                      <Pressable onPress={() => run_(onDelete, 'Could not delete this run.')} disabled={busy}>
                        <Text style={styles.dangerText}>Confirm</Text>
                      </Pressable>
                      <Pressable onPress={() => setConfirmingDelete(false)} disabled={busy}>
                        <Text style={styles.mutedText}>Cancel</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable onPress={() => setConfirmingDelete(true)} disabled={busy}>
                      <Text style={styles.dangerText}>Discard draft</Text>
                    </Pressable>
                  )}
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// Local editing state so typing doesn't fire a write per keystroke; the value
// is committed on blur.
function PayrollLineRow({
  line,
  editable,
  onCommit,
}: {
  line: PayrollRunLine;
  editable: boolean;
  onCommit: (amountCents: number) => void;
}) {
  const [draft, setDraft] = useState((line.amountCents / 100).toFixed(2));

  const commit = () => {
    const cents = toCents(draft);
    if (cents !== line.amountCents) onCommit(cents);
  };

  const basis =
    line.payType === 'hourly'
      ? `${line.hoursWorked ?? 0}h at ${line.payRateCents !== null ? formatAccountingCents(line.payRateCents) : '—'}/h`
      : line.payType
        ? `${line.payType === 'salary' ? 'Salary' : 'Fixed'} · ${line.payRateCents !== null ? formatAccountingCents(line.payRateCents) : '—'}`
        : 'No pay rate set';

  return (
    <View style={styles.lineRow}>
      <View style={styles.lineMain}>
        <Text style={styles.lineName}>{line.memberName ?? 'Staff member'}</Text>
        <Text style={styles.lineBasis}>{basis}</Text>
      </View>
      {editable ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          keyboardType="decimal-pad"
          style={styles.lineInput}
        />
      ) : (
        <Text style={styles.lineAmount}>{formatAccountingCents(line.amountCents)}</Text>
      )}
    </View>
  );
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, maxHeight: '88%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 12 },
  headerMain: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  title: { fontSize: 15, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  body: { flexGrow: 0 },

  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F2F2F2' },
  lineMain: { flex: 1, minWidth: 0 },
  lineName: { fontSize: 13, fontWeight: '700', color: '#111111' },
  lineBasis: { fontSize: 11, color: '#999999', marginTop: 2 },
  lineInput: { backgroundColor: '#F2F2F2', borderRadius: 8, height: 38, width: 100, paddingHorizontal: 10, color: '#111111', textAlign: 'right', fontWeight: '700' },
  lineAmount: { fontSize: 13, fontWeight: '800', color: '#111111' },

  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 14, marginTop: 4 },
  totalLabel: { fontSize: 13, fontWeight: '800', color: '#111111' },
  totalValue: { fontSize: 20, fontWeight: '800', color: '#111111' },

  note: { fontSize: 11, color: '#999999', lineHeight: 16, marginTop: 16 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 12 },
  empty: { color: '#999999', fontSize: 13, textAlign: 'center', paddingVertical: 20 },

  primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  secondaryButton: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  secondaryButtonText: { color: '#111111', fontWeight: '800', fontSize: 13 },
  buttonDisabled: { opacity: 0.5 },
  deleteRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  confirmText: { fontSize: 12, fontWeight: '600', color: '#111111' },
  dangerText: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  mutedText: { fontSize: 12, fontWeight: '700', color: '#999999' },
});
