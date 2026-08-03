import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PayrollRunEditor } from '@/components/accounting/payroll-run-editor';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { CategoryChip } from '@/components/category-chip';
import { DateInput, parseDateInput } from '@/components/date-input';
import type { DateRange } from '@/components/range-selector';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents } from '@/lib/currency';
import { computePayrollDraft } from '@/lib/payroll-reporting';
import {
  createPayrollRun,
  deletePayrollRun,
  getPayrollRun,
  listPayrollRuns,
  postPayrollRun,
  unpostPayrollRun,
  updatePayrollRunLine,
} from '@/lib/payroll';
import { payPeriodsFor, type PayCadence } from '@/lib/pay-periods';
import { toDateColumn } from '@/lib/period';
import { listStaff } from '@/lib/staff';
import { listShopTimeEntries } from '@/lib/time-entries';
import type { PayrollRun } from '@/types/models';

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function PayrollTab({
  dateRange,
  setHeaderActions,
}: {
  dateRange: DateRange;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop, can } = useAuth();
  // Both are required: pay rates are sensitive, and posting writes a real
  // expense. The database enforces the same pair.
  const allowed = can('people.payroll.manage') && can('expenses.manage');

  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [open, setOpen] = useState<PayrollRun | null>(null);
  const [creating, setCreating] = useState(false);
  // Defaults to the current calendar month rather than the Accounting
  // rolling-days range: seeding from that range meant the dates almost never
  // lined up with a whole pay period, so "Build draft" always took the
  // prorated branch even for a salaried member. `periods[0]` is guaranteed
  // here -- payPeriodsFor('monthly', ...) over a single day always returns
  // exactly the one month containing it -- but the fallback keeps this call
  // from ever throwing if that guarantee changes.
  const thisMonth = payPeriodsFor('monthly', null, toDateColumn(new Date()), toDateColumn(new Date())).periods[0]
    ?? { start: toDateColumn(new Date()), end: toDateColumn(new Date()) };
  const [cadence, setCadence] = useState<PayCadence | null>('monthly');
  const [periodStart, setPeriodStart] = useState(thisMonth.start);
  const [periodEnd, setPeriodEnd] = useState(thisMonth.end);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anchor = shop?.payPeriodAnchor ?? null;
  const periodOptions = cadence
    ? payPeriodsFor(cadence, anchor, toDateColumn(dateRange.since), toDateColumn(dateRange.until ?? new Date()))
    : { periods: [], reason: 'ok' as const };

  const reload = useCallback(async () => {
    if (!shop || !allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setRuns(await listPayrollRuns(shop.id));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop, allowed]);

  useEffect(() => { reload(); }, [reload]);

  // Pay data is RLS-protected, so a role without both permissions can't read
  // any of this. Say so rather than rendering an empty screen that looks broken.
  if (!allowed) {
    return (
      <Text style={styles.empty}>
        Pay runs need both payroll and expense permissions. Ask an owner to grant them in Settings → Roles.
      </Text>
    );
  }

  const refreshOpen = async (runId: string) => {
    setOpen(await getPayrollRun(runId));
    await reload();
  };

  const startRun = async () => {
    if (!shop) return;
    const start = parseDateInput(periodStart);
    const end = parseDateInput(periodEnd);
    if (!start || !end || end < start) {
      setError('Enter a valid period — the end date must be on or after the start.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The draft is computed here from staff and clocked hours, then stored
      // as written -- so what gets saved is exactly what was reviewed.
      const [members, entries] = await Promise.all([
        listStaff(shop.id),
        listShopTimeEntries(shop.id, { sinceIso: start.toISOString() }),
      ]);
      const lines = computePayrollDraft(members, entries, periodStart, periodEnd, cadence, anchor);
      const created = await createPayrollRun(shop.id, periodStart, periodEnd, lines, cadence);
      setCreating(false);
      setOpen(created);
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <PayrollHeaderActions allowed={allowed} creating={creating} onNew={() => setCreating(true)} setHeaderActions={setHeaderActions} />
      <View style={styles.header}>
        <Text style={styles.subtitle}>
          Turn clocked hours and pay rates into a cost. Posting a run adds it to expenses so wages count against profit.
        </Text>
      </View>

      {creating && (
        <View style={styles.createCard}>
          <Text style={styles.createTitle}>Pay period</Text>
          <View style={styles.chips}>
            {(['weekly', 'biweekly', 'semimonthly', 'monthly'] as const).map((option) => (
              <CategoryChip
                key={option}
                label={option === 'biweekly' ? 'Every 2 weeks' : option === 'semimonthly' ? 'Twice a month' : option[0].toUpperCase() + option.slice(1)}
                active={cadence === option}
                onPress={() => setCadence(option)}
              />
            ))}
            <CategoryChip label="Custom dates" active={cadence === null} onPress={() => setCadence(null)} />
          </View>
          {periodOptions.reason === 'anchor_required' ? (
            <Text style={styles.subtitle}>
              Set a pay period start date in Settings → Store before using weekly or fortnightly periods.
            </Text>
          ) : (
            <View style={styles.chips}>
              {periodOptions.periods.map((period) => (
                <CategoryChip
                  key={`${period.start}-${period.end}`}
                  label={`${period.start} → ${period.end}`}
                  active={periodStart === period.start && periodEnd === period.end}
                  onPress={() => {
                    setPeriodStart(period.start);
                    setPeriodEnd(period.end);
                  }}
                />
              ))}
            </View>
          )}
          <View style={styles.createRow}>
            <View style={styles.createField}>
              <Text style={styles.fieldLabel}>FROM</Text>
              <DateInput value={periodStart} onChangeText={setPeriodStart} />
            </View>
            <View style={styles.createField}>
              <Text style={styles.fieldLabel}>TO</Text>
              <DateInput value={periodEnd} onChangeText={setPeriodEnd} />
            </View>
          </View>
          <View style={styles.createActions}>
            <Pressable onPress={startRun} disabled={busy} style={[styles.primaryButton, busy && styles.buttonDisabled]}>
              <Text style={styles.primaryButtonText}>{busy ? 'Working…' : 'Build draft'}</Text>
            </Pressable>
            <Pressable onPress={() => { setCreating(false); setError(null); }} disabled={busy} style={styles.actionButton}>
              <Text style={styles.actionButtonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : runs.length === 0 ? (
        <Text style={styles.empty}>No pay runs yet.</Text>
      ) : (
        <View style={styles.list}>
          {runs.map((r) => {
            const total = r.status === 'posted' ? r.totalCents : (r.lines ?? []).reduce((s, l) => s + l.amountCents, 0);
            return (
              <Pressable key={r.id} onPress={() => setOpen(r)} style={styles.card}>
                <View style={styles.cardMain}>
                  <Text style={styles.cardTitle}>{r.periodStart} to {r.periodEnd}</Text>
                  <Text style={styles.cardMeta}>
                    {(r.lines ?? []).length} {(r.lines ?? []).length === 1 ? 'person' : 'people'}
                    {r.postedAt ? ` · posted ${new Date(r.postedAt).toLocaleDateString()}` : ''}
                  </Text>
                </View>
                <View style={styles.cardRight}>
                  <Badge label={r.status === 'posted' ? 'Posted' : 'Draft'} tone={r.status === 'posted' ? 'success' : 'default'} />
                  <Text style={styles.cardAmount}>{formatAccountingCents(total)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      {open && (
        <PayrollRunEditor
          key={open.id}
          run={open}
          onClose={() => setOpen(null)}
          onChangeLine={async (lineId, amountCents) => {
            await updatePayrollRunLine(lineId, { amountCents });
            await refreshOpen(open.id);
          }}
          onPost={async () => {
            await postPayrollRun(open.id);
            await refreshOpen(open.id);
          }}
          onUnpost={async () => {
            await unpostPayrollRun(open.id);
            await refreshOpen(open.id);
          }}
          onDelete={async () => {
            await deletePayrollRun(open.id);
            setOpen(null);
            await reload();
          }}
        />
      )}
    </View>
  );
}

// A child rather than a hook call in PayrollTab: that component returns early
// when the role lacks permission, and hooks can't sit after a conditional
// return.
function PayrollHeaderActions({
  allowed,
  creating,
  onNew,
  setHeaderActions,
}: {
  allowed: boolean;
  creating: boolean;
  onNew: () => void;
  setHeaderActions: HeaderActionsSetter;
}) {
  useHeaderActions(
    setHeaderActions,
    allowed && !creating ? (
      <Pressable onPress={onNew} style={styles.newButton}>
        <Text style={styles.newButtonText}>+ New pay run</Text>
      </Pressable>
    ) : null,
    [allowed, creating, onNew]
  );
  return null;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  subtitle: { fontSize: 11.5, color: '#999999', flexShrink: 1, lineHeight: 16 },
  newButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },

  createCard: { borderWidth: 1, borderColor: '#ECECEC', borderRadius: 14, padding: 16, marginBottom: 16 },
  createTitle: { fontSize: 13, fontWeight: '800', color: '#111111', marginBottom: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  createRow: { flexDirection: 'row', gap: 10 },
  createField: { flex: 1 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6 },
  createActions: { flexDirection: 'row', gap: 8, marginTop: 14 },

  list: { gap: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: '#ECECEC', padding: 14 },
  cardMain: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 13.5, fontWeight: '700', color: '#111111' },
  cardMeta: { fontSize: 11, color: '#999999', marginTop: 3 },
  cardRight: { alignItems: 'flex-end', gap: 6 },
  cardAmount: { fontSize: 14, fontWeight: '800', color: '#111111' },

  primaryButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 11, alignItems: 'center' },
  primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  actionButton: { paddingVertical: 11, paddingHorizontal: 16, borderRadius: 10, backgroundColor: '#F2F2F2' },
  actionButtonText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  buttonDisabled: { opacity: 0.5 },

  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center', lineHeight: 19 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
