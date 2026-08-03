import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { InvoiceEditorModal } from '@/components/accounting/invoice-editor-modal';
import { RecordPaymentModal } from '@/components/accounting/record-payment-modal';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import type { DateRange } from '@/components/range-selector';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatAccountingCents } from '@/lib/currency';
import {
  balanceCents,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_TONES,
  invoiceStatus,
  invoiceTotals,
  sortInvoicesForDisplay,
} from '@/lib/invoice-reporting';
import { createInvoice, deleteInvoice, deleteInvoicePayment, listInvoices, recordInvoicePayment, updateInvoice } from '@/lib/invoices';
import { isDateColumnInRange } from '@/lib/period';
import type { Invoice } from '@/types/models';

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function InvoicesTab({
  dateRange,
  setHeaderActions,
}: {
  dateRange: DateRange;
  setHeaderActions: HeaderActionsSetter;
}) {
  const { shop, can } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 860;
  const canManage = can('invoices.manage');

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [editing, setEditing] = useState<Invoice | 'new' | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    try {
      setInvoices(await listInvoices(shop.id));
      setError(null);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  // Totals cover every bill, not just the visible window -- what you owe is a
  // fact about now, and a bill raised before the selected range is exactly the
  // one you'd not want hidden.
  const totals = useMemo(() => invoiceTotals(invoices), [invoices]);

  // The list, by contrast, respects the range so it stays browsable.
  const visible = useMemo(() => {
    const inRange = invoices.filter((invoice) => isDateColumnInRange(invoice.issuedOn, dateRange.since, dateRange.until));
    return sortInvoicesForDisplay(inRange);
  }, [invoices, dateRange]);

  const close = () => setEditing(null);

  // The modal holds a snapshot, so after recording a payment it has to be
  // re-read from the refreshed list or it shows a stale balance.
  const refreshPaying = (rows: Invoice[]) => {
    setPaying((current) => (current ? rows.find((i) => i.id === current.id) ?? null : null));
  };

  const reloadAnd = async () => {
    if (!shop) return;
    const rows = await listInvoices(shop.id);
    setInvoices(rows);
    refreshPaying(rows);
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

  return (
    <View>
      <View style={styles.metricRow}>
        <StatTile
          value={formatAccountingCents(totals.outstandingCents)}
          label="Still owed"
          tone={totals.outstandingCents > 0 ? 'warning' : 'default'}
        />
        <StatTile
          value={formatAccountingCents(totals.overdueCents)}
          label="Overdue"
          tone={totals.overdueCents > 0 ? 'warning' : 'default'}
        />
        <StatTile value={String(totals.openCount)} label="Unpaid bills" />
      </View>

      <View style={styles.header}>
        <Text style={styles.subtitle}>Bills you owe suppliers. Totals cover every unpaid bill, not just this date range.</Text>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : visible.length === 0 ? (
        <Text style={styles.empty}>
          {invoices.length === 0 ? 'No bills recorded yet.' : 'No bills issued in this date range.'}
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
                    <Badge label={INVOICE_STATUS_LABELS[status]} tone={INVOICE_STATUS_TONES[status]} />
                    <Text style={styles.cardAmount}>
                      {outstanding > 0 ? `${formatAccountingCents(outstanding)} owed` : formatAccountingCents(invoice.amountCents)}
                    </Text>
                  </View>
                </View>
                {canManage && (
                  <View style={styles.actionRow}>
                    {outstanding > 0 && (
                      <Pressable onPress={() => setPaying(invoice)} style={styles.payButton}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 18, flexWrap: 'wrap' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  subtitle: { fontSize: 11.5, color: '#999999', flexShrink: 1, lineHeight: 16 },
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
