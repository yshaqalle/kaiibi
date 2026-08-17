import { FontAwesome, Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as MailComposer from 'expo-mail-composer';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { formatCents, formatForeignCents } from '@/lib/currency';
import { openExternalUrl } from '@/lib/external-url';
import { KAIIBI_MARK_DATA_URI } from '@/lib/kaiibi-mark';
import { methodLabel } from '@/lib/payment-methods';
import { qrModules, qrPathData, qrViewBox, receiptPayload, receiptShortCode } from '@/lib/qr';
import { buildReceiptHtml, buildReceiptText, merchantIdFor, type ReceiptData } from '@/lib/receipt';
import { generateReceiptPdf } from '@/lib/receipt-pdf';
import { openWhatsApp } from '@/lib/whatsapp';
import { AppModal } from '@/components/ui/app-modal';

// The receipt is a monospace object -- the item columns only line up because
// every glyph is one width -- so the preview has to be monospace too, or it
// stops being a preview of what prints.
//
// No single family name works on both platforms. Android resolves the generic
// 'monospace' (Droid Sans Mono); iOS resolves nothing for it and silently falls
// back to the system sans, which is exactly the failure this preview exists to
// catch -- it would look fine and print misaligned. Menlo ships with every iOS
// version.
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

// The printed receipt gets its QR as an <svg> string from qr.ts; here the
// same modules are handed to react-native-svg instead, so both surfaces
// encode the identical payload from the identical code path.
function qrModulesFor(saleId: string) {
  const modules = qrModules(receiptPayload(saleId));
  return { path: qrPathData(modules), viewBox: qrViewBox(modules) };
}

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
  // Not wrapped in useMemo: it would have to sit above the early return to keep
  // hook order stable, and the optional chaining that then needs (`receipt?.`)
  // gives the React Compiler a dependency it can't match, so it bails out of
  // optimizing this component entirely. Left plain, the compiler memoizes it
  // for us -- and encoding a 25x25 symbol is a few hundred boolean writes, far
  // below the cost of the render it sits in.
  const qr = receipt.saleId ? qrModulesFor(receipt.saleId) : null;
  const location = [receipt.shopCity, receipt.shopNeighborhood].filter((p) => p && p.trim()).join(' · ') || null;
  const when = new Date(receipt.createdAt);
  const hasCustomer = Boolean(receipt.customer.name || receipt.customer.phone || receipt.customer.email);
  // Inside the item table and the summary the currency symbol is repeated on
  // every line for no gain, and on 80mm each character costs real width. Only
  // TOTAL and the payment amounts keep it. Mirrors `money()` in
  // buildReceiptHtml so the preview and the paper agree.
  const money = (cents: number) => formatCents(cents).replace(/^\$/, '');

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
    <AppModal visible transparent animationType="fade" onRequestClose={onClose}>
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
                {receipt.shopLogoUrl && <Image source={{ uri: receipt.shopLogoUrl }} contentFit="contain" style={styles.logo} />}
                <Text style={styles.shopName}>{receipt.shopName}</Text>
                {receipt.locationName && <Text style={styles.storeName}>{receipt.locationName}</Text>}
                {location && <Text style={styles.shopMeta}>{location}</Text>}
                {receipt.shopContactPhone && <Text style={styles.shopMeta}>{receipt.shopContactPhone}</Text>}
                {receipt.shopHours && <Text style={styles.shopMeta}>{receipt.shopHours}</Text>}
              </View>

              <View style={styles.dashedDivider} />

              {receipt.saleId && (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Receipt #</Text>
                  <Text style={styles.rowValue}>{receiptShortCode(receipt.saleId)}</Text>
                </View>
              )}
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Date</Text>
                <Text style={styles.rowValue}>{when.toLocaleDateString()}</Text>
              </View>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Time</Text>
                <Text style={styles.rowValue}>{when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>
              </View>
              {receipt.cashierName && (
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Cashier</Text>
                  <Text style={styles.rowValue}>{receipt.cashierName}</Text>
                </View>
              )}

              <View style={styles.dashedDivider} />

              <View style={styles.itemHead}>
                <Text style={[styles.itemHeadCell, styles.colName]}>ITEM</Text>
                <Text style={[styles.itemHeadCell, styles.colQty]}>QTY</Text>
                <Text style={[styles.itemHeadCell, styles.colPrice]}>PRICE</Text>
                <Text style={[styles.itemHeadCell, styles.colTotal]}>TOTAL</Text>
              </View>
              <View style={styles.itemHeadRule} />
              {receipt.items.map((line, i) => {
                const gross = line.unitPriceCents * line.quantity;
                const discount = line.discountCents ?? 0;
                return (
                  <View key={i} style={styles.itemRow}>
                    <View style={styles.colName}>
                      <Text style={styles.itemName}>{line.name}</Text>
                      {discount > 0 && <Text style={styles.itemSub}>{`discount −${money(discount)}`}</Text>}
                    </View>
                    <Text style={[styles.itemCell, styles.colQty]}>{line.quantity}</Text>
                    <Text style={[styles.itemCell, styles.colPrice]}>{money(line.unitPriceCents)}</Text>
                    <Text style={[styles.itemCell, styles.colTotal]}>{money(gross - discount)}</Text>
                  </View>
                );
              })}

              <View style={styles.totals}>
                {Boolean(receipt.discountCents && receipt.discountCents > 0) && (
                  <>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>Subtotal</Text>
                      <Text style={styles.rowValue}>{money(receipt.subtotalCents ?? receipt.totalCents + (receipt.discountCents ?? 0))}</Text>
                    </View>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>Discount</Text>
                      <Text style={styles.rowValue}>−{money(receipt.discountCents ?? 0)}</Text>
                    </View>
                  </>
                )}
                {Boolean(receipt.pointsRedeemed && receipt.pointsRedeemed > 0) && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Points used ({receipt.pointsRedeemed})</Text>
                    <Text style={styles.rowValue}>−{money(receipt.pointsRedeemedCents ?? 0)}</Text>
                  </View>
                )}
                {Boolean(receipt.taxCents && receipt.taxCents > 0) && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Tax ({receipt.taxRatePercent}%)</Text>
                    <Text style={styles.rowValue}>{money(receipt.taxCents ?? 0)}</Text>
                  </View>
                )}
                <View style={styles.grandRow}>
                  <Text style={styles.grandLabel}>TOTAL</Text>
                  <Text style={styles.grandValue}>{formatCents(receipt.totalCents)}</Text>
                </View>
              </View>

              <View style={styles.dashedDivider} />

              {receipt.payments.map((payment, i) => {
                const hasCurrency = payment.currencyCode && payment.foreignAmountCents !== null && payment.exchangeRate !== null;
                const hasChange = hasCurrency && payment.foreignChangeCents && payment.foreignChangeCents > 0;
                const merchantId = merchantIdFor(receipt, payment.method);
                return (
                  <View key={i}>
                    <View style={styles.row}>
                      <Text style={styles.rowLabel}>
                        {hasCurrency ? `${methodLabel(payment.method)} (${payment.currencyCode})` : methodLabel(payment.method)}
                      </Text>
                      <Text style={styles.rowValue}>{formatCents(payment.amountCents)}</Text>
                    </View>
                    {hasCurrency && (
                      <Text style={styles.paymentSub}>
                        {formatForeignCents(payment.foreignAmountCents as number, payment.currencyCode as string)} @ {payment.exchangeRate}/$
                        {hasChange ? ` · change ${formatForeignCents(payment.foreignChangeCents as number, payment.currencyCode as string)}` : ''}
                      </Text>
                    )}
                    {merchantId && <Text style={styles.paymentSub}>Merchant ID {merchantId}</Text>}
                  </View>
                );
              })}


              {/* Boxed, not just another row: this is the one number on the
                  paper that says the transaction is not finished, and it has to
                  survive being glanced at. The name is on it rather than only in
                  CUSTOMER below -- this is the half that comes back over the
                  counter when they pay, and it must say whose debt it is alone. */}
              {Boolean(receipt.balanceDueCents && receipt.balanceDueCents > 0) && (
                <View style={styles.balanceDue}>
                  <View style={styles.row}>
                    <Text style={styles.balanceDueLabel}>BALANCE DUE</Text>
                    <Text style={styles.balanceDueValue}>{formatCents(receipt.balanceDueCents as number)}</Text>
                  </View>
                  {receipt.customer.name && (
                    <Text style={styles.balanceOwedBy}>Owed by {receipt.customer.name}</Text>
                  )}
                </View>
              )}

              {hasCustomer && (
                <>
                  <View style={styles.dashedDivider} />
                  <Text style={styles.sectionLabel}>CUSTOMER</Text>
                  {receipt.customer.name && <Text style={styles.customer}>{receipt.customer.name}</Text>}
                  {receipt.customer.phone && <Text style={styles.customer}>{receipt.customer.phone}</Text>}
                  {receipt.customer.email && <Text style={styles.customer}>{receipt.customer.email}</Text>}
                  {Boolean(receipt.pointsEarned && receipt.pointsEarned > 0) && (
                    <Text style={styles.customer}>Points earned: {receipt.pointsEarned}</Text>
                  )}
                </>
              )}

              {qr && receipt.saleId && (
                <View style={styles.qrBlock}>
                  <Svg width={62} height={62} viewBox={qr.viewBox}>
                    <Path d={qr.path} fill="#111111" />
                  </Svg>
                  <Text style={styles.qrNum}>{receiptShortCode(receipt.saleId)}</Text>
                </View>
              )}

              <Text style={styles.thanks}>THANK YOU FOR YOUR PURCHASE!</Text>
              {Boolean(receipt.returnPolicy && receipt.returnPolicy.trim()) && (
                <Text style={styles.policy}>{receipt.returnPolicy?.trim()}</Text>
              )}

              {receipt.showKaiibiBranding !== false && (
                <View style={styles.poweredBy}>
                  <Text style={styles.pbText}>Powered by</Text>
                  <Image source={{ uri: KAIIBI_MARK_DATA_URI }} contentFit="contain" style={styles.pbMark} />
                  <Text style={styles.pbName}>Kaiibi</Text>
                </View>
              )}
            </View>
          </View>
          </ScrollView>

          <View style={styles.actions}>
            {Platform.OS === 'web' && (
              <Pressable onPress={() => printHtml(buildReceiptHtml(receipt))} style={styles.actionButton}>
                <Ionicons name="print-outline" size={20} color="#FFFFFF" />
                <Text style={styles.actionLabel}>Print</Text>
              </Pressable>
            )}
            <Pressable onPress={shareEmail} disabled={busy !== null} style={styles.actionButton}>
              {busy === 'email' ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="mail-outline" size={20} color="#FFFFFF" />}
              <Text style={styles.actionLabel}>Email</Text>
            </Pressable>
            <Pressable onPress={shareWhatsApp} style={styles.actionButton}>
              <FontAwesome name="whatsapp" size={20} color="#FFFFFF" />
              <Text style={styles.actionLabel}>WhatsApp</Text>
            </Pressable>
            {Platform.OS !== 'web' && (
              <Pressable onPress={shareGeneric} disabled={busy !== null} style={styles.actionButton}>
                {busy === 'share' ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="share-outline" size={20} color="#FFFFFF" />}
                <Text style={styles.actionLabel}>Share</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </AppModal>
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
  // White stock with a hairline edge, not the old cream card: this previews a
  // thing that comes off a roll, and thermal paper has exactly one colour.
  receipt: { backgroundColor: '#FFFFFF', borderRadius: 4, borderWidth: 1, borderColor: '#E6E4DE', paddingHorizontal: 16, paddingTop: 20, paddingBottom: 14 },
  receiptHead: { alignItems: 'center', marginBottom: 2 },
  logo: { width: 42, height: 42, borderRadius: 9, marginBottom: 8 },
  shopName: { fontFamily: MONO, fontSize: 17, fontWeight: '700', color: '#111111', letterSpacing: 1.2, textTransform: 'uppercase', textAlign: 'center', marginBottom: 3 },
  storeName: { fontFamily: MONO, fontSize: 11, color: '#333333', letterSpacing: 0.6, textTransform: 'uppercase', textAlign: 'center', marginBottom: 6 },
  shopMeta: { fontFamily: MONO, fontSize: 10.5, color: '#333333', textAlign: 'center', marginVertical: 1 },

  // RN's dashed border renders as a solid line on some Android versions, so
  // the rule is drawn as a row of fixed-width dashes instead. It also matches
  // the printed rule, which is a repeating gradient for the same reason.
  dashedDivider: { borderTopWidth: 1, borderTopColor: '#C9C9C9', borderStyle: 'dashed', marginVertical: 11 },

  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginVertical: 2 },
  rowLabel: { fontFamily: MONO, flex: 1, fontSize: 11.5, color: '#333333' },
  rowValue: { fontFamily: MONO, fontSize: 11.5, color: '#111111', textAlign: 'right' },

  itemHead: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 4 },
  itemHeadCell: { fontFamily: MONO, fontSize: 10, fontWeight: '700', color: '#111111', letterSpacing: 0.6 },
  itemHeadRule: { borderTopWidth: 1, borderTopColor: '#C9C9C9', borderStyle: 'dashed', marginTop: 5, marginBottom: 2 },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 4 },
  itemName: { fontFamily: MONO, fontSize: 11, color: '#111111' },
  itemSub: { fontFamily: MONO, fontSize: 9.5, color: '#666666' },
  itemCell: { fontFamily: MONO, fontSize: 11, color: '#111111', textAlign: 'right' },
  // Fixed widths, not flex: the columns have to hold their position from row
  // to row or the numbers stop lining up, which is the whole reason the
  // receipt is monospace.
  colName: { flex: 1, paddingRight: 8 },
  colQty: { width: 26 },
  colPrice: { width: 52 },
  colTotal: { width: 56 },

  totals: { marginTop: 8 },
  // Same monospace and type scale as every other line -- the receipt design does
  // not change, it gains a line. The 1.5px rule matches grandRow, because this is
  // the second figure on the paper that carries that weight.
  balanceDue: { borderWidth: 1.5, borderColor: '#111111', paddingVertical: 7, paddingHorizontal: 8, marginTop: 9, marginBottom: 3 },
  balanceDueLabel: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#111111', letterSpacing: 0.5 },
  balanceDueValue: { fontFamily: MONO, fontSize: 13, fontWeight: '700', color: '#111111' },
  balanceOwedBy: { fontFamily: MONO, fontSize: 10.5, color: '#111111', marginTop: 3 },
  grandRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', borderTopWidth: 1.5, borderTopColor: '#111111', marginTop: 8, paddingTop: 9 },
  grandLabel: { fontFamily: MONO, fontSize: 15, fontWeight: '700', color: '#111111', letterSpacing: 0.5 },
  grandValue: { fontFamily: MONO, fontSize: 15, fontWeight: '700', color: '#111111' },

  paymentSub: { fontFamily: MONO, fontSize: 9.5, color: '#666666', marginBottom: 2 },
  sectionLabel: { fontFamily: MONO, fontSize: 9.5, fontWeight: '700', color: '#666666', letterSpacing: 1, marginBottom: 3 },
  customer: { fontFamily: MONO, fontSize: 10.5, color: '#333333' },

  qrBlock: { alignItems: 'center', marginTop: 14, marginBottom: 4 },
  qrNum: { fontFamily: MONO, fontSize: 9.5, color: '#333333', letterSpacing: 2.5, marginTop: 6 },

  thanks: { fontFamily: MONO, fontSize: 11.5, fontWeight: '700', color: '#111111', letterSpacing: 0.5, textAlign: 'center', marginTop: 12, marginBottom: 3 },
  policy: { fontFamily: MONO, fontSize: 9.5, color: '#555555', lineHeight: 14, textAlign: 'center', marginBottom: 3 },

  poweredBy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 14, paddingTop: 11, borderTopWidth: 1, borderTopColor: '#C9C9C9', borderStyle: 'dashed' },
  pbText: { fontFamily: MONO, fontSize: 9.5, color: '#888888', letterSpacing: 0.3 },
  pbMark: { width: 14, height: 14, borderRadius: 3 },
  pbName: { fontFamily: MONO, fontSize: 10.5, fontWeight: '700', color: '#111111', letterSpacing: 0.4 },

  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  actionButton: { flexGrow: 1, flexBasis: '22%', minWidth: 76, backgroundColor: '#111111', borderRadius: 12, paddingVertical: 13, alignItems: 'center', gap: 5 },
  actionLabel: { fontSize: 11, fontWeight: '700', color: '#FFFFFF' },
});
