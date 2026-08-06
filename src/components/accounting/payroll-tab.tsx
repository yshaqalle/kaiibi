import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PayrollRunEditor } from '@/components/accounting/payroll-run-editor';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { CategoryChip } from '@/components/category-chip';
import { DateInput, parseDateInput } from '@/components/date-input';
import type { DateRange } from '@/components/range-selector';
import { BentoFlow } from '@/components/ui/bento';
import { BentoCard } from '@/components/ui/bento-card';
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
import type { PayrollRun, StaffMember } from '@/types/models';

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

// Shared by the chips and the coverage line so the prose can never say
// "biweekly" while the chip says "Every 2 weeks".
const CADENCE_LABELS: Record<PayCadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
};

// A second vocabulary for the coverage prose: the chip labels above read well
// as button text ("Every 2 weeks") but not as adjectives mid-sentence ("This
// every 2 weeks run..."). These read correctly in both "This __ run" and
// "the __ cadence" positions.
const CADENCE_ADJECTIVES: Record<PayCadence, string> = {
  weekly: 'weekly',
  biweekly: 'fortnightly',
  semimonthly: 'twice-monthly',
  monthly: 'monthly',
};

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
  // Loaded when the create card opens so the covered count can be shown before
  // a run exists. Null means "not loaded yet" -- distinct from an empty roster.
  const [activeStaff, setActiveStaff] = useState<StaffMember[] | null>(null);
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
  // Bumped each time openCreate runs so a slow, superseded listStaff response
  // can be told apart from the latest one and discarded instead of clobbering
  // fresher state -- see openCreate below.
  const createRequestRef = useRef(0);

  const anchor = shop?.payPeriodAnchor ?? null;
  const periodOptions = cadence
    ? payPeriodsFor(cadence, anchor, toDateColumn(dateRange.since), toDateColumn(dateRange.until ?? new Date()))
    : { periods: [], reason: 'ok' as const };

  // How many of the active roster this run will actually include. The draft
  // silently drops members on a different cadence, so without this a shop that
  // moves to weekly and misses one member excludes them from every run.
  const coveredCount =
    activeStaff === null ? null : cadence === null ? activeStaff.length : activeStaff.filter((member) => member.payCadence === cadence).length;

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
      <BentoFlow>
        <BentoCard title="Payroll">
          <Text style={styles.empty}>
            Pay runs need both payroll and expense permissions. Ask an owner to grant them in Settings → Roles.
          </Text>
        </BentoCard>
      </BentoFlow>
    );
  }

  const refreshOpen = async (runId: string) => {
    setOpen(await getPayrollRun(runId));
    await reload();
  };

  // Deliberately not a useEffect keyed on `creating`: this file already carries
  // a react-hooks/set-state-in-effect finding, and adding another effect that
  // sets state would add a second.
  const openCreate = async () => {
    setCreating(true);
    setActiveStaff(null);
    const requestId = ++createRequestRef.current;
    if (!shop) return;
    try {
      const members = await listStaff(shop.id);
      // Discard a superseded response: Cancel stays clickable while this is
      // in flight, so a quick cancel-and-reopen can leave two calls racing.
      if (createRequestRef.current !== requestId) return;
      setActiveStaff(members.filter((member) => member.active));
    } catch {
      // A failed load leaves the count hidden rather than blocking the card --
      // startRun re-fetches and will surface a real error there.
      if (createRequestRef.current !== requestId) return;
      setActiveStaff(null);
    }
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

  // Flow, not a grid — this is a ledger. See BentoFlow.
  return (
    <BentoFlow>
      <PayrollHeaderActions allowed={allowed} creating={creating} onNew={openCreate} setHeaderActions={setHeaderActions} />

      {/* No title: the page header two lines above already says "Payroll",
          and repeating it made the screen read as having two headings. This
          card is a note, not a section. */}
      <BentoCard>
        <Text style={styles.subtitle}>
          Turn clocked hours and pay rates into a cost. Posting a run adds it to expenses so wages count against profit.
        </Text>
      </BentoCard>

      {creating && (
        <BentoCard title="New pay run">
          <Text style={styles.createTitle}>Pay period</Text>
          <View style={styles.chips}>
            {(['weekly', 'biweekly', 'semimonthly', 'monthly'] as const).map((option) => (
              <CategoryChip
                key={option}
                label={CADENCE_LABELS[option]}
                active={cadence === option}
                onPress={() => setCadence(option)}
              />
            ))}
            <CategoryChip label="Custom dates" active={cadence === null} onPress={() => setCadence(null)} />
          </View>
          {activeStaff !== null && coveredCount !== null && (
            <View style={styles.coverageRow}>
              {/* Zero is tested first, and the two zeroes are distinguished:
                  having no active staff at all is a different problem from
                  having nobody on the chosen cadence, and the second one's
                  advice is useless for the first. */}
              <Text style={coveredCount === 0 ? styles.coverageEmpty : styles.coverage}>
                {activeStaff.length === 0
                  ? 'There are no active staff to pay.'
                  : cadence === null
                    ? `This run covers all ${activeStaff.length} active staff.`
                    : coveredCount === 0
                      ? `No active staff are on the ${CADENCE_ADJECTIVES[cadence]} cadence. Set one in People, then check again.`
                      : `This ${CADENCE_ADJECTIVES[cadence]} run covers ${coveredCount} of ${activeStaff.length} active staff.`}
              </Text>
              {/* NativeTabs keeps this screen mounted, so going to People to set
                  a cadence and coming back leaves the count stale and Build
                  draft disabled, with nothing saying Cancel/New would recover.
                  Deliberately a control rather than a focus effect: this file
                  already carries a react-hooks/set-state-in-effect finding. */}
              {coveredCount === 0 && activeStaff.length > 0 && (
                <Pressable onPress={openCreate}>
                  <Text style={styles.coverageRetry}>Check again</Text>
                </Pressable>
              )}
            </View>
          )}
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
            <Pressable
              onPress={startRun}
              disabled={busy || coveredCount === 0}
              style={[styles.primaryButton, (busy || coveredCount === 0) && styles.buttonDisabled]}
            >
              <Text style={styles.primaryButtonText}>{busy ? 'Working…' : 'Build draft'}</Text>
            </Pressable>
            <Pressable onPress={() => { setCreating(false); setError(null); }} disabled={busy} style={styles.actionButton}>
              <Text style={styles.actionButtonText}>Cancel</Text>
            </Pressable>
          </View>
        </BentoCard>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* The empty and loading states live INSIDE the card, not above it: a
          tab with no pay runs yet should read as an empty card, not as a line
          of grey text floating on the page. */}
      <BentoCard title="Pay runs" scope="All time">
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
                  <Badge variant="bento" label={r.status === 'posted' ? 'Posted' : 'Draft'} tone={r.status === 'posted' ? 'success' : 'default'} />
                  <Text style={styles.cardAmount}>{formatAccountingCents(total)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
      </BentoCard>

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
    </BentoFlow>
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
  coverageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' },
  coverage: { fontSize: 11.5, color: '#999999', lineHeight: 16, marginBottom: 10, flexShrink: 1 },
  coverageEmpty: { fontSize: 11.5, fontWeight: '700', color: '#C0392B', lineHeight: 16, marginBottom: 10, flexShrink: 1 },
  coverageRetry: { fontSize: 11.5, fontWeight: '800', color: '#111111', lineHeight: 16, textDecorationLine: 'underline' },
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
