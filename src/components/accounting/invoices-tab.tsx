import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { InvoiceEditorModal } from '@/components/accounting/invoice-editor-modal';
import { RecordPaymentModal } from '@/components/accounting/record-payment-modal';
import { useHeaderActions, type HeaderActionsSetter, useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { BentoFlow } from '@/components/ui/bento';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { useAuth } from '@/hooks/use-auth';
import { scopeToLocation } from '@/lib/location-reporting';
import { formatAccountingCents, formatCompactCents } from '@/lib/currency';
import { listAccounts, listPostedLines } from '@/lib/ledger';
import { payableDebitCents } from '@/lib/ledger-math';
import { toDateColumn } from '@/lib/period';
import {
  balanceCents,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_TONES,
  invoiceStatus,
  invoiceTotals,
  sortInvoicesForDisplay,
} from '@/lib/invoice-reporting';
import {
  createInvoice,
  deleteInvoice,
  deleteInvoicePayment,
  getInvoiceWithPayments,
  listInvoicesInRange,
  listOpenInvoices,
  recordInvoicePayment,
  updateInvoice,
} from '@/lib/invoices';
import type { Invoice } from '@/types/models';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function InvoicesTab({
  dateRange,
  locationFilter,
  setHeaderActions,
  setRefresh,
}: {
  dateRange: DateRange;
  /** Owned by the Accounting shell so it survives a tab switch. null = every store. */
  locationFilter: string | null;
  setHeaderActions: HeaderActionsSetter;
  setRefresh: RefreshSetter;
}) {
  const { shop, can } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  const canManage = can('invoices.manage');

  // Two sets, because the tiles and the list want different things: the
  // tiles need every unpaid bill however old, the list needs what was issued
  // in the selected window. Neither wants "every bill ever".
  // null = the combined business view. A bill can belong to no single store
  // (a group insurance policy), and picking a store excludes those.
  const [openInvoices, setOpenInvoices] = useState<Invoice[]>([]);
  const [rangeInvoices, setRangeInvoices] = useState<Invoice[]>([]);
  const [editing, setEditing] = useState<Invoice | 'new' | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);
  // Tracks the FIRST fetch, not every fetch. `reload()` runs again after each
  // edit here, and swapping the rendered rows for a placeholder on those
  // collapsed the scroll content to a few pixels -- the platform then clamps
  // the scroll offset to fit, so the list came back at the top and whoever was
  // reading it lost their place after every change. Gating on "has anything
  // arrived yet" keeps the rows mounted, so they keep their height and their
  // position, and the values update underneath. First found in inventory.tsx.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How far 2000 Accounts Payable has gone into DEBIT, which is the wrong way
  // round for a liability. See the caveat below and payableDebitCents().
  //
  // Shop-wide and as of today, deliberately unaffected by `locationFilter` and
  // by the date range: a liability that has gone negative is a fact about the
  // books as they stand, and slicing it by branch or by window would let the
  // reader make it disappear by changing a picker.
  const [payableDebit, setPayableDebit] = useState(0);

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      const [open, inRange] = await Promise.all([
        listOpenInvoices(shop.id),
        listInvoicesInRange(shop.id, dateRange.since, dateRange.until),
      ]);
      setOpenInvoices(open);
      setRangeInvoices(inRange);
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoaded(true);
    }

    // SEPARATE FROM THE FETCH ABOVE, AND ITS FAILURE IS NOT THIS SCREEN'S
    // ERROR. Reading the ledger needs `ledger.view`, which somebody who holds
    // `invoices.manage` may well not have -- RLS on journal_entries and
    // journal_lines then returns no rows rather than an error, which reads as a
    // payable of zero and simply shows no caveat. That is the right
    // degradation: a bookkeeper who cannot open the trial balance is not the
    // person this note is for. Anything that DOES throw is swallowed for the
    // same reason -- a qualification failing to load must not blank the list of
    // bills it was meant to qualify.
    try {
      const [accounts, lines] = await Promise.all([
        listAccounts(shop.id),
        listPostedLines(shop.id, toDateColumn(new Date())),
      ]);
      setPayableDebit(payableDebitCents(accounts, lines));
    } catch {
      setPayableDebit(0);
    }
  }, [shop, dateRange]);

  useEffect(() => { reload(); }, [reload]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);
  // Published to the shell, which owns the scroller the pull happens on.
  useTabRefresh(setRefresh, reload);

  // Scoped before totalling: "what does this store still owe" has to exclude
  // the business's own bills, or every store looks like it owes them.
  const openInScope = useMemo(() => scopeToLocation(openInvoices, locationFilter), [openInvoices, locationFilter]);
  const rangeInScope = useMemo(() => scopeToLocation(rangeInvoices, locationFilter), [rangeInvoices, locationFilter]);

  const totals = useMemo(() => invoiceTotals(openInScope), [openInScope]);

  // Unpaid bills always show, even when issued outside the window -- the list
  // would otherwise disagree with the totals right above it. Merged by id so a
  // bill in both sets appears once.
  const visible = useMemo(() => {
    const byId = new Map(rangeInScope.map((invoice) => [invoice.id, invoice]));
    for (const invoice of openInScope) byId.set(invoice.id, invoice);
    return sortInvoicesForDisplay(Array.from(byId.values()));
  }, [rangeInScope, openInScope]);

  const close = () => setEditing(null);

  const openPaymentModal = async (id: string) => {
    setError(null);
    try {
      setPaying(await getInvoiceWithPayments(id));
    } catch (err) {
      setError(extractErrorMessage(err));
    }
  };

  // The modal holds a snapshot, so after a payment it has to be re-read or it
  // shows a stale balance. Fetched individually because it's the only place
  // that needs the payment history.
  const reloadAnd = async () => {
    const current = paying;
    await reload();
    if (current) setPaying(await getInvoiceWithPayments(current.id));
  };

  useHeaderActions(
    setHeaderActions,
    canManage ? (
      <Pressable onPress={() => setEditing('new')} style={styles.newButton}>
        <Text style={styles.newButtonText}>+ New bill</Text>
      </Pressable>
    ) : null,
    [canManage]
  );

  // Flow, not a grid — this is a ledger. See BentoFlow.
  return (
    <BentoFlow>
      {/* "As of today", not the range: what you owe is a fact about now, and
          invoice-reporting.ts already insists on it. */}
      <BentoCard title="What you owe" scope="As of today">
        <View style={styles.metricRow}>
          <StatTile variant="bento"
            value={formatCompactCents(totals.outstandingCents)}
            label="Still owed"
            tone={totals.outstandingCents > 0 ? 'warning' : 'default'}
          />
          <StatTile variant="bento"
            value={formatCompactCents(totals.overdueCents)}
            label="Overdue"
            tone={totals.overdueCents > 0 ? 'warning' : 'default'}
          />
          <StatTile variant="bento" value={String(totals.openCount)} label="Unpaid bills" />
        </View>
        <Text style={styles.subtitle}>
          Bills you owe suppliers. Totals cover every unpaid bill, not just this date range.
        </Text>
        {/* A NEGATIVE ACCOUNTS PAYABLE, SAID OUT LOUD.

            `tone="wrong"`, not `context`. The figure really is wrong -- a
            liability in debit says suppliers owe the shop money, which is not
            a surprising-but-correct number, it is a number no reading of the
            business supports. `context` would be the app claiming the balance
            sheet is fine, and the first person to see a negative Accounts
            Payable on their first balance sheet would conclude kaiibi cannot
            add up. They would be right.

            AND `wrong` CARRIES A FIX, because there is one and it is the same
            thing the shop should be doing anyway. The cause is a bill for goods
            that has no delivery behind it: `receive_stock` is what raises the
            payable (Cr 2000 when stock lands), so a bill categorised
            inventory_purchase deliberately posts nothing -- posting it too would
            raise the payable twice. Pay that bill and Dr 2000 comes off a
            balance nothing ever put there. Recording the missing delivery in
            Inventory credits 2000 by exactly the delivery's value and the
            account comes back; it also corrects stock records that were already
            wrong, which is why this is a real remedy rather than a gesture. A
            `wrong` with no fix is what trains people to ignore the whole family,
            and this one is not that.

            NOT DISMISSIBLE. `onDismiss` on a `wrong` leaves the app knowingly
            showing a bad number with nothing to say so, and this one persists
            until the delivery is entered -- there is no reading of it that
            becomes stale. The proper fix is the invoices<->stock_receipts link
            in phase 3; until then this is the whole defence. */}
        {payableDebit > 0 ? (
          <Caveat
            tone="wrong"
            action={{ label: 'Record the delivery in Inventory', onPress: () => router.push('/inventory') }}
          >
            {`Your books currently say suppliers owe YOU ${formatAccountingCents(payableDebit)}, which is the wrong way round. It happens when a bill for goods gets paid but the delivery was never entered in Inventory — the payment comes off money the books never saw arrive. Enter the missing delivery and this corrects itself.`}
          </Caveat>
        ) : null}
      </BentoCard>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <BentoCard title="Bills" scope="Selected range">
      {!loaded ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : visible.length === 0 ? (
        <Text style={styles.empty}>
          {openInvoices.length === 0 ? 'No bills recorded yet.' : 'No bills issued in this date range.'}
        </Text>
      ) : (
        <View style={styles.list}>
          {visible.map((invoice) => {
            const status = invoiceStatus(invoice);
            const outstanding = balanceCents(invoice);
            return (
              <View key={invoice.id} style={styles.card}>
                <View style={[styles.cardTop, compact && styles.cardTopCompact]}>
                  <View style={styles.cardMain}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{invoice.vendorName ?? 'Vendor'}</Text>
                    {invoice.description ? <Text style={styles.cardDesc} numberOfLines={1}>{invoice.description}</Text> : null}
                    <Text style={styles.cardMeta}>
                      {invoice.invoiceNumber} · issued {invoice.issuedOn} · due {invoice.dueOn}
                    </Text>
                  </View>
                  <View style={[styles.cardRight, compact && styles.cardRightCompact]}>
                    <Badge variant="bento" label={INVOICE_STATUS_LABELS[status]} tone={INVOICE_STATUS_TONES[status]} />
                    <Text style={styles.cardAmount}>
                      {outstanding > 0 ? `${formatAccountingCents(outstanding)} owed` : formatAccountingCents(invoice.amountCents)}
                    </Text>
                  </View>
                </View>
                {canManage && (
                  <View style={styles.actionRow}>
                    {outstanding > 0 && (
                      <Pressable onPress={() => openPaymentModal(invoice.id)} style={styles.payButton}>
                        <Text style={styles.payButtonText}>Record payment</Text>
                      </Pressable>
                    )}
                    <Pressable onPress={() => setEditing(invoice)} style={styles.actionButton}>
                      <Text style={styles.actionButtonText}>Edit</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
      </BentoCard>

      {editing !== null && shop && (
        <InvoiceEditorModal
          key={editing === 'new' ? 'new' : editing.id}
          shopId={shop.id}
          invoice={editing === 'new' ? null : editing}
          onClose={close}
          onSave={async (input) => {
            if (editing !== 'new') await updateInvoice(editing.id, input);
            else await createInvoice(shop.id, input);
            await reload();
            close();
          }}
          onDelete={
            editing !== 'new'
              ? async () => {
                  await deleteInvoice(editing.id);
                  await reload();
                  close();
                }
              : undefined
          }
        />
      )}

      {paying && (
        <RecordPaymentModal
          key={paying.id}
          invoice={paying}
          onClose={() => setPaying(null)}
          onRecord={async (amountCents, opts) => {
            await recordInvoicePayment(paying.id, amountCents, opts);
            await reloadAnd();
          }}
          onDeletePayment={async (paymentId) => {
            await deleteInvoicePayment(paymentId);
            await reloadAnd();
          }}
        />
      )}
    </BentoFlow>
  );
}

const styles = StyleSheet.create({
  metricRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  subtitle: { fontSize: 11.5, color: '#999999', flexShrink: 1, lineHeight: 16, marginTop: 12 },
  newButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  newButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },

  list: { gap: 10 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, borderWidth: 1, borderColor: '#ECECEC', padding: 14 },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardTopCompact: { flexDirection: 'column' },
  cardMain: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 13.5, fontWeight: '700', color: '#111111' },
  cardDesc: { fontSize: 12, color: '#555555', marginTop: 2 },
  cardMeta: { fontSize: 11, color: '#999999', marginTop: 3 },
  cardRight: { alignItems: 'flex-end', gap: 6 },
  cardRightCompact: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 10 },
  cardAmount: { fontSize: 14, fontWeight: '800', color: '#111111' },

  actionRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  payButton: { backgroundColor: '#438254', borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14 },
  payButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  actionButton: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#F2F2F2' },
  actionButtonText: { fontSize: 12, fontWeight: '700', color: '#111111' },

  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginBottom: 12 },
});
