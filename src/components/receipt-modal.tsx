import { Image } from 'expo-image';
import * as MailComposer from 'expo-mail-composer';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { formatCents, formatForeignCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import { methodLabel } from '@/lib/payment-methods';
import { buildReceiptHtml, buildReceiptText, type ReceiptData } from '@/lib/receipt';
import { generateReceiptPdf } from '@/lib/receipt-pdf';
import { openWhatsApp } from '@/lib/whatsapp';

const tornEdgeNotches = Array.from({ length: 18 });

// Module-level (not component-scoped) so both the manual Print button and
// the auto-print effect below can call it — the effect runs before these
// would be declared if they lived inside the component body after the
// early `!receipt` return, which the React Compiler rejects as "accessed
// before declared".
//
// A hidden same-page <iframe> instead of window.open(..., '_blank'): some
// browsers (notably mobile ones, and any with popups blocked) silently
// reuse the *current* tab for a blocked/failed popup instead of opening a
// new one — which meant `win.document.write(...)` was overwriting this
// entire app's DOM with the receipt page, so "closing" what looked like a
// new tab was actually navigating away from the app. An iframe never
// leaves the current page at all, so there's nothing to navigate to or
// "close" that could affect the app underneath.
function printHtml(html: string) {
  // @ts-ignore — web-only DOM APIs, only ever called on Platform.OS === 'web'.
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  // @ts-ignore
  document.body.appendChild(iframe);
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    iframe.remove();
    return;
  }
  frameWindow.document.open();
  frameWindow.document.write(html);
  frameWindow.document.close();
  frameWindow.focus();
  frameWindow.print();
  // The print dialog is effectively synchronous from the browser's
  // perspective, so a short delay is enough before tearing the iframe down
  // — removing it immediately can cancel the print on some browsers.
  setTimeout(() => iframe.remove(), 1000);
}

export function ReceiptModal({
  receipt,
  onClose,
  title = 'Receipt',
  autoPrint = false,
  autoSendWhatsApp = false,
}: {
  receipt: ReceiptData | null;
  onClose: () => void;
  title?: string;
  // Set from the shop's Receipt settings (Settings → Receipt) — fires the
  // same action the manual Print/WhatsApp buttons below do, once, right
  // after a fresh checkout. Not used when reopening a past sale's receipt
  // (see sales.tsx), only the just-completed one in pos.tsx.
  autoPrint?: boolean;
  autoSendWhatsApp?: boolean;
}) {
  const [busy, setBusy] = useState<'share' | 'email' | null>(null);
  // Effects must run unconditionally (before the `!receipt` early return
  // below) to keep hook order stable across renders where `receipt` toggles
  // between null and a value on this same mounted instance.
  const autoTriggeredFor = useRef<ReceiptData | null>(null);
  useEffect(() => {
    if (!receipt || autoTriggeredFor.current === receipt) return;
    autoTriggeredFor.current = receipt;
    if (autoPrint && Platform.OS === 'web') printHtml(buildReceiptHtml(receipt));
    if (autoSendWhatsApp && receipt.customer.phone) {
      openWhatsApp(receipt.customer.phone, buildReceiptText(receipt));
    }
  }, [receipt, autoPrint, autoSendWhatsApp]);

  if (!receipt) return null;
  const location = [receipt.shopCity, receipt.shopNeighborhood].filter((p) => p && p.trim()).join(' · ') || null;

  const mailtoFallback = () => {
    const subject = encodeURIComponent(`Receipt from ${receipt.shopName}`);
    const body = encodeURIComponent(buildReceiptText(receipt));
    const to = receipt.customer.email ?? '';
    openExternalUrl(`mailto:${to}?subject=${subject}&body=${body}`);
  };

  const shareEmail = async () => {
    if (Platform.OS === 'web') {
      mailtoFallback();
      return;
    }
    setBusy('email');
    try {
      const available = await MailComposer.isAvailableAsync();
      if (!available) throw new Error('mail composer unavailable');
      const uri = await generateReceiptPdf(receipt);
      await MailComposer.composeAsync({
        recipients: receipt.customer.email ? [receipt.customer.email] : [],
        subject: `Receipt from ${receipt.shopName}`,
        body: buildReceiptText(receipt),
        attachments: [uri],
      });
    } catch {
      mailtoFallback();
    } finally {
      setBusy(null);
    }
  };

  const shareWhatsApp = () => {
    openWhatsApp(receipt.customer.phone ?? '', buildReceiptText(receipt));
  };

  const shareGeneric = async () => {
    setBusy('share');
    try {
      const uri = await generateReceiptPdf(receipt);
      const available = await Sharing.isAvailableAsync();
      if (!available) throw new Error('sharing unavailable');
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        UTI: 'com.adobe.pdf',
        dialogTitle: `Receipt from ${receipt.shopName}`,
      });
    } catch {
      Share.share({ message: buildReceiptText(receipt) }).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.badge}><Text style={styles.badgeCheck}>✓</Text></View>
              <Text style={styles.title}>{title}</Text>
            </View>
            <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
              <Text style={styles.closeText}>Done</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.receiptScroll}>
          <View style={styles.receiptWrap}>
            <View style={styles.receipt}>
              <View style={styles.receiptHead}>
                {receipt.shopLogoUrl && <Image source={{ uri: receipt.shopLogoUrl }} contentFit="cover" style={styles.logo} />}
                <Text style={styles.shopName}>{receipt.shopName}</Text>
                {location && <Text style={styles.muted}>{location}</Text>}
                {receipt.shopContactPhone && <Text style={styles.muted}>{receipt.shopContactPhone}</Text>}
                <Text style={styles.muted}>{new Date(receipt.createdAt).toLocaleString()}</Text>
                {receipt.cashierName && <Text style={styles.muted}>{`Served by ${receipt.cashierName}`}</Text>}
              </View>

              <View style={styles.dashedDivider} />
              {receipt.items.map((line, i) => {
                const gross = line.unitPriceCents * line.quantity;
                const discount = line.discountCents ?? 0;
                return (
                  <View key={i}>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel} numberOfLines={1}>{`${line.quantity} × ${line.name}`}</Text>
                      <Text style={styles.rowValue}>{formatCents(gross - discount)}</Text>
                    </View>
                    {discount > 0 && (
                      <View style={styles.row}>
                        <Text style={styles.muted}>Discount</Text>
                        <Text style={styles.muted}>-{formatCents(discount)}</Text>
                      </View>
                    )}
                  </View>
                );
              })}

              <View style={styles.dashedDivider} />
              {Boolean(receipt.discountCents && receipt.discountCents > 0) && (
                <>
                  <View style={styles.row}>
                    <Text style={styles.muted}>Subtotal</Text>
                    <Text style={styles.muted}>{formatCents(receipt.subtotalCents ?? receipt.totalCents + (receipt.discountCents ?? 0))}</Text>
                  </View>
                  <View style={styles.row}>
                    <Text style={styles.muted}>Discount</Text>
                    <Text style={styles.muted}>-{formatCents(receipt.discountCents ?? 0)}</Text>
                  </View>
                </>
              )}
              {Boolean(receipt.taxCents && receipt.taxCents > 0) && (
                <View style={styles.row}>
                  <Text style={styles.muted}>Tax ({receipt.taxRatePercent}%)</Text>
                  <Text style={styles.muted}>{formatCents(receipt.taxCents ?? 0)}</Text>
                </View>
              )}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalValue}>{formatCents(receipt.totalCents)}</Text>
              </View>
              {receipt.payments.map((payment, i) => {
                const hasCurrency = payment.currencyCode && payment.foreignAmountCents !== null && payment.exchangeRate !== null;
                const hasChange = hasCurrency && payment.foreignChangeCents && payment.foreignChangeCents > 0;
                return (
                  <View key={i} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.muted}>{methodLabel(payment.method)}</Text>
                      {hasCurrency && (
                        <Text style={styles.muted}>
                          {formatForeignCents(payment.foreignAmountCents as number, payment.currencyCode as string)} @ {payment.exchangeRate}/$
                        </Text>
                      )}
                      {hasChange && (
                        <Text style={styles.muted}>
                          Change {formatForeignCents(payment.foreignChangeCents as number, payment.currencyCode as string)}
                        </Text>
                      )}
                    </View>
                    <Text style={styles.muted}>{formatCents(payment.amountCents)}</Text>
                  </View>
                );
              })}

              {(receipt.customer.name || receipt.customer.phone || receipt.customer.email) && (
                <>
                  <View style={styles.dashedDivider} />
                  <Text style={styles.sectionLabel}>CUSTOMER</Text>
                  {receipt.customer.name && <Text style={styles.muted}>{receipt.customer.name}</Text>}
                  {receipt.customer.phone && <Text style={styles.muted}>{receipt.customer.phone}</Text>}
                  {receipt.customer.email && <Text style={styles.muted}>{receipt.customer.email}</Text>}
                </>
              )}

              {Boolean(receipt.returnPolicy && receipt.returnPolicy.trim()) && (
                <>
                  <View style={styles.dashedDivider} />
                  <Text style={styles.returnPolicy}>{receipt.returnPolicy}</Text>
                </>
              )}

              <Text style={styles.thanks}>Thank you for your purchase!</Text>
            </View>
            <View style={styles.tornEdge}>
              {tornEdgeNotches.map((_, i) => <View key={i} style={styles.tornNotch} />)}
            </View>
          </View>
          </ScrollView>

          <View style={styles.actions}>
            {Platform.OS === 'web' && (
              <Pressable onPress={() => printHtml(buildReceiptHtml(receipt))} style={styles.actionButton}>
                <Text style={styles.actionIcon}>🖨️</Text>
                <Text style={styles.actionLabel}>Print</Text>
              </Pressable>
            )}
            <Pressable onPress={shareEmail} disabled={busy !== null} style={styles.actionButton}>
              {busy === 'email' ? <ActivityIndicator size="small" /> : <Text style={styles.actionIcon}>✉️</Text>}
              <Text style={styles.actionLabel}>Email</Text>
            </Pressable>
            <Pressable onPress={shareWhatsApp} style={styles.actionButton}>
              <Text style={styles.actionIcon}>💬</Text>
              <Text style={styles.actionLabel}>WhatsApp</Text>
            </Pressable>
            {Platform.OS !== 'web' && (
              <Pressable onPress={shareGeneric} disabled={busy !== null} style={styles.actionButton}>
                {busy === 'share' ? <ActivityIndicator size="small" /> : <Text style={styles.actionIcon}>↗️</Text>}
                <Text style={styles.actionLabel}>Share</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  // `height` (not `maxHeight`) — `receiptScroll` below is `flex: 1` and
  // needs a concrete parent size to fill; against a `maxHeight`-only,
  // content-sized parent it resolves to zero height instead of scrolling
  // (the same Yoga flex-basis pitfall as the POS split panes; see pos.tsx).
  card: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20, width: '100%', maxWidth: 420, height: '88%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center' },
  badgeCheck: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },

  receiptScroll: { flex: 1 },
  receiptWrap: { marginBottom: 18 },
  receipt: { backgroundColor: '#F3F2ED', borderTopLeftRadius: 14, borderTopRightRadius: 14, padding: 20 },
  receiptHead: { alignItems: 'center', marginBottom: 4 },
  logo: { width: 48, height: 48, borderRadius: 11, marginBottom: 8 },
  shopName: { fontSize: 17, fontWeight: '800', color: '#111111', letterSpacing: 0.2 },
  muted: { color: '#777777', fontSize: 12, marginTop: 2, textAlign: 'center' },
  sectionLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 4, marginTop: 2 },
  dashedDivider: { borderTopWidth: 1.5, borderTopColor: '#D9D9D3', borderStyle: 'dashed', marginVertical: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 4, gap: 10 },
  rowLabel: { flex: 1, fontSize: 13, color: '#333333' },
  rowValue: { fontSize: 13, fontWeight: '700', color: '#111111' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#111111', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 4 },
  totalLabel: { fontSize: 14, fontWeight: '800', color: '#FFFFFF', letterSpacing: 0.3 },
  totalValue: { fontSize: 17, fontWeight: '800', color: '#FFFFFF' },
  returnPolicy: { color: '#777777', fontSize: 11, lineHeight: 16, marginTop: 2 },
  thanks: { marginTop: 16, textAlign: 'center', color: '#999999', fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },

  tornEdge: { flexDirection: 'row', height: 10, backgroundColor: '#F3F2ED', overflow: 'hidden' },
  tornNotch: {
    width: 0,
    height: 0,
    flexGrow: 1,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#FFFFFF',
    marginRight: -7,
  },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionButton: { flexGrow: 1, flexBasis: '22%', minWidth: 76, backgroundColor: '#111111', borderRadius: 12, paddingVertical: 13, alignItems: 'center', gap: 5 },
  actionIcon: { fontSize: 19 },
  actionLabel: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
});
