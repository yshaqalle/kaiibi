import { formatCents, formatForeignCents } from '@/lib/currency';
import { KAIIBI_MARK_DATA_URI } from '@/lib/kaiibi-mark';
import { methodLabel } from '@/lib/payment-methods';
import { qrSvg, receiptPayload, receiptShortCode } from '@/lib/qr';
import { formatDayHours, rangesFor, weekdayKeyFor, type OpeningHours } from '@/lib/store-hours';
import type { PaymentLine, Sale } from '@/types/models';

// A lighter shape than `CartLine`/`SaleItem` — just what a receipt needs to
// print a line, so both a fresh POS cart and a historical `Sale` (whose
// items reference a product that may since have been renamed or deleted)
// can build one the same way.
export type ReceiptItem = { name: string; quantity: number; unitPriceCents: number; discountCents?: number };

export type ReceiptData = {
  // The sale this receipt is for. Printed as a short code and encoded whole
  // into the QR, so a scan resolves to exactly one sale — see src/lib/qr.ts.
  //
  // Nullable because the receipt is not the sale: a caller that has rendered
  // one without an id (a preview, a test) should get a receipt missing its
  // code rather than a crash. Both the code line and the QR disappear together
  // when it is null, so a receipt never shows a number with nothing to scan.
  saleId: string | null;
  shopName: string;
  shopLogoUrl: string | null;
  // The name of the branch this sale was rung up at, printed under the shop
  // name. Null for a single-location shop — repeating "Main" under the shop's
  // own name tells the customer nothing.
  locationName: string | null;
  // The address, phone and hours below are the SELLING LOCATION's, not the
  // business's: a receipt is proof of a transaction at a place, and the
  // customer holding it needs to know which door to come back to.
  shopCity: string | null;
  shopNeighborhood: string | null;
  shopContactPhone: string | null;
  // Today's hours only, pre-formatted. A whole week's table would dominate a
  // narrow receipt; today's line is what someone holding it wants. Null when
  // hours are unset or the shop is closed today.
  shopHours: string | null;
  // Who rang up the sale, if a cashier profile was picked in the POS — see
  // migration 0009. Optional: most shops are a single owner running the
  // register themselves.
  cashierName: string | null;
  // The selling location's mobile-money merchant numbers, printed under the
  // payment line that used them and nowhere else — a cash-only receipt shows
  // neither. Per location, not per shop: `Shop.paymentZaadEnabled` decides
  // whether the business takes ZAAD, these say which till at this branch
  // received it (migration 20260821000000).
  zaadMerchantId: string | null;
  edahabMerchantId: string | null;
  // Printed at the bottom of the receipt, below "Thank you" — set in
  // Settings and applies to every sale, not captured per-sale.
  returnPolicy: string | null;
  // Whether to print the "Powered by Kaiibi" footer. Defaults to true
  // everywhere it isn't explicitly resolved, which is the point: a shop only
  // loses the mark when its plan grants `receipt_branding_removal`, so a new
  // shop, a trial, a lapsed plan and a plan nobody has looked at all keep it.
  showKaiibiBranding?: boolean;
  items: ReceiptItem[];
  payments: PaymentLine[];
  customer: { name: string | null; phone: string | null; email: string | null };
  // Gross (pre-discount) total and the total discount taken off it — both
  // optional/omittable so a receipt with no discount at all can skip the
  // breakdown and just show the total, same as before this feature existed.
  subtotalCents?: number;
  discountCents?: number;
  // Tax applied on top of the discounted subtotal, and the rate that
  // produced it — omitted (or 0) when tax wasn't enabled for this sale.
  taxCents?: number;
  taxRatePercent?: number | null;
  // Loyalty points spent on this sale and what they took off, printed as their
  // own line rather than folded into `discountCents` — a customer needs to see
  // their points did something, and the shop's own discount is a different
  // fact. Both 0/omitted when no points were used.
  pointsRedeemed?: number;
  pointsRedeemedCents?: number;
  // Points this sale earned, printed inside the CUSTOMER block since that's
  // the only case where earning happens at all.
  //
  // Deliberately no balance-after: buildReceiptFromSale has no balance to work
  // from, so a reprint could not reproduce it, and a receipt that prints a
  // different number the second time is worse than one that omits it.
  pointsEarned?: number;
  totalCents: number;
  // What is still owed on THIS sale after the payments above -- a sale taken
  // partly or wholly on credit. Printed as its own boxed line rather than
  // folded into the total: the total is what the goods came to, and it does not
  // change because the customer has not finished paying for them.
  //
  // Unlike `pointsEarned` this IS reproducible on a reprint --
  // buildReceiptFromSale can read it back off the sale's own payments -- so a
  // second copy shows the same figure as the first.
  balanceDueCents?: number;
  createdAt: string;
};

// The store's name, but only when it adds something. A shop's first store is
// created named after the business (migration 20260808000000), so printing both
// gives a receipt with the same words twice — which is what happens the moment a
// second store is added and the name starts being printed at all.
//
// Exported so the POS checkout path, which builds a ReceiptData directly rather
// than from a Sale, applies the same rule.
export function storeNameFor(shopName: string, locationName: string | null, show: boolean): string | null {
  if (!show || !locationName) return null;
  return locationName.trim() === shopName.trim() ? null : locationName;
}

function formatLocation(receipt: Pick<ReceiptData, 'shopCity' | 'shopNeighborhood'>): string | null {
  const parts = [receipt.shopCity, receipt.shopNeighborhood].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Null rather than 'Closed' when the shop is shut: a receipt is proof of a sale
// that just happened, so printing "Closed" on it would be absurd.
//
// `on` is the date the receipt is FOR, not the moment it is rendered. Reprinting
// last Tuesday's sale would otherwise print *today's* hours directly under a
// date line showing the sale's own date — and once emailed or saved as a PDF
// that string freezes and goes stale, so the same sale's receipt would not even
// be reproducible from one day to the next. "Open today" is only true on the
// day itself, so a receipt for any other day carries no hours line at all.
//
// Exported so callers that build a ReceiptData without going through
// `buildReceiptFromSale` (the POS checkout flow, which has a fresh cart
// rather than a `Sale`) can compute the same field the same way.
export function formatTodayHours(hours: OpeningHours | undefined, on: Date): string | null {
  if (!hours) return null;
  const now = new Date();
  const isToday =
    on.getFullYear() === now.getFullYear() && on.getMonth() === now.getMonth() && on.getDate() === now.getDate();
  if (!isToday) return null;
  const today = rangesFor(hours, weekdayKeyFor(on));
  if (today.length === 0) return null;
  const formatted = formatDayHours(today);
  return formatted === 'Closed' ? null : `Open today ${formatted}`;
}

// Reconstructs a receipt for a past sale — so a customer who comes back
// later asking for their receipt again can be helped from the Sales screen,
// not just right after checkout.
// `location` is the branch the sale was rung up at, resolved by the caller from
// `sale.locationId`, and it is the ONLY source of the address, phone and hours —
// the shop itself no longer has any (migration 20260811000000). There is
// deliberately nothing to fall back to: a second source is what let a receipt
// print an address the owner had already changed.
//
// An unresolved location therefore prints no address rather than a stale one,
// which is the right failure — a receipt with no address is incomplete, a
// receipt with the wrong address sends someone to the wrong door.
//
// `showLocationName` is the caller's decision rather than inferred here,
// because "is this shop multi-location" is a fact about the shop, not about the
// one location passed in.
export function buildReceiptFromSale(
  sale: Sale,
  shop: {
    name: string;
    logoUrl: string | null;
    returnPolicy: string | null;
    receiptShowLogo?: boolean;
    receiptShowCashierName?: boolean;
  },
  location?: {
    name: string;
    city: string | null;
    neighborhood: string | null;
    contactPhone: string | null;
    openingHours: OpeningHours;
    zaadMerchantId?: string | null;
    edahabMerchantId?: string | null;
  } | null,
  showLocationName = false,
  // Resolved by the caller from `hasModule('receipt_branding_removal')`.
  // Defaulted to true here rather than left to the caller: a caller that
  // forgets it prints the mark, which is the safe direction to fail.
  showKaiibiBranding = true
): ReceiptData {
  const subtotalCents = (sale.items ?? []).reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  return {
    saleId: sale.id,
    shopName: shop.name,
    shopLogoUrl: shop.receiptShowLogo === false ? null : shop.logoUrl,
    locationName: storeNameFor(shop.name, location?.name ?? null, showLocationName),
    shopCity: location?.city ?? null,
    shopNeighborhood: location?.neighborhood ?? null,
    shopContactPhone: location?.contactPhone ?? null,
    shopHours: formatTodayHours(location?.openingHours, new Date(sale.createdAt)),
    cashierName: shop.receiptShowCashierName === false ? null : sale.cashierName,
    zaadMerchantId: location?.zaadMerchantId ?? null,
    edahabMerchantId: location?.edahabMerchantId ?? null,
    returnPolicy: shop.returnPolicy,
    showKaiibiBranding,
    items: (sale.items ?? []).map((item) => ({ name: item.productName, quantity: item.quantity, unitPriceCents: item.unitPriceCents, discountCents: item.discountCents })),
    payments: (sale.payments ?? []).map((p) => ({
      method: p.method,
      amountCents: p.amountCents,
      tenderedCents: p.tenderedCents,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      currencyCode: p.currencyCode,
      exchangeRate: p.exchangeRate,
      foreignAmountCents: p.foreignAmountCents,
      foreignChangeCents: p.foreignChangeCents,
    })),
    customer: { name: sale.customerName, phone: sale.customerPhone, email: sale.customerEmail },
    subtotalCents,
    // The points come back out of the derived figure: they're already inside
    // (total - tax), and leaving them there would print them twice, once as a
    // discount the shop never gave and once on the points line below.
    discountCents: subtotalCents - (sale.totalCents - sale.taxCents) - sale.pointsRedeemedCents,
    taxCents: sale.taxCents,
    taxRatePercent: sale.taxRatePercent,
    pointsRedeemed: sale.pointsRedeemed,
    pointsRedeemedCents: sale.pointsRedeemedCents,
    pointsEarned: sale.pointsEarned,
    totalCents: sale.totalCents,
    // Derived from the sale's own rows, so a reprint shows the balance CURRENT
    // rather than as it was: reprint a receipt for a sale since paid off and the
    // line is simply gone. Settlements live in `sale.payments` alongside the
    // till's own, which is what makes that work (migration 20260831000100 keeps
    // them there rather than replacing them).
    //
    // Gated on settled_at, not on the payments alone. mapSaleRow coerces missing
    // payments to `[]`, so a caller that selected the sale without them is
    // indistinguishable from one where nothing was ever paid -- and subtracting
    // nothing from the total would print a fabricated debt, with the customer's
    // name on it, on a receipt for a sale they settled in full. An absent
    // settled_at reads as settled for the same reason: the wrong direction here
    // is a receipt that invents money owed, not one that omits a line.
    balanceDueCents: sale.settledAt === null
      ? Math.max(
          0,
          sale.totalCents
            // Goods returned, not cash handed back: the same arithmetic
            // customer_balances and settle_sale_balance use. Without this term a
            // part-paid, part-refunded sale printed a debt the customer had
            // already settled by handing the goods in -- and printed their name
            // under it. No refund stamps settled_at, so nothing else caught it.
            - (sale.refunds ?? []).reduce((sum, r) => sum + r.goodsCents, 0)
            - (sale.payments ?? []).reduce((sum, p) => sum + p.amountCents, 0)
        )
      : 0,
    createdAt: sale.createdAt,
  };
}

// The merchant number to print under a payment line, or null when there is
// nothing to print — which covers cash, "other", and a mobile-money payment at
// a branch that hasn't entered its number yet.
//
// Whitespace-only counts as unset: an owner who tabbed through the field and
// left a space should not get a receipt reading "Merchant ID" followed by
// nothing.
export function merchantIdFor(
  receipt: Pick<ReceiptData, 'zaadMerchantId' | 'edahabMerchantId'>,
  method: PaymentLine['method']
): string | null {
  const id = method === 'zaad' ? receipt.zaadMerchantId : method === 'edahab' ? receipt.edahabMerchantId : null;
  return id && id.trim() ? id.trim() : null;
}

// Renders a single payment's amount, plus the foreign-currency detail it was
// tendered in (if any) — e.g. a customer paying in EUR for a USD-priced sale.
function formatPaymentLine(payment: PaymentLine): string {
  const base = `${methodLabel(payment.method)}: ${formatCents(payment.amountCents)}`;
  if (!payment.currencyCode || payment.foreignAmountCents === null || payment.exchangeRate === null) return base;
  const changeSuffix = payment.foreignChangeCents && payment.foreignChangeCents > 0
    ? ` (change ${formatForeignCents(payment.foreignChangeCents, payment.currencyCode)})`
    : '';
  return `${methodLabel(payment.method)} (${payment.currencyCode}): ${formatForeignCents(payment.foreignAmountCents, payment.currencyCode)} @ ${payment.exchangeRate}/$ = ${formatCents(payment.amountCents)}${changeSuffix}`;
}

// Plain text — used for the Email body and the WhatsApp prefilled message,
// where markup would either be stripped or shown as literal tags.
export function buildReceiptText(receipt: ReceiptData): string {
  const lines: string[] = [];
  lines.push(receipt.shopName);
  if (receipt.locationName) lines.push(receipt.locationName);
  const location = formatLocation(receipt);
  if (location) lines.push(location);
  if (receipt.shopContactPhone) lines.push(receipt.shopContactPhone);
  if (receipt.shopHours) lines.push(receipt.shopHours);
  lines.push('');
  // The short code, not the QR payload: this is read by a person, and the
  // full uuid would be noise in a WhatsApp message.
  if (receipt.saleId) lines.push(`Receipt #${receiptShortCode(receipt.saleId)}`);
  lines.push(new Date(receipt.createdAt).toLocaleString());
  if (receipt.cashierName) lines.push(`Served by ${receipt.cashierName}`);
  lines.push('');
  for (const line of receipt.items) {
    const gross = line.unitPriceCents * line.quantity;
    const discount = line.discountCents ?? 0;
    lines.push(`${line.quantity} x ${line.name} - ${formatCents(gross - discount)}`);
    if (discount > 0) lines.push(`  discount: -${formatCents(discount)}`);
  }
  lines.push('');
  if (receipt.discountCents && receipt.discountCents > 0) {
    lines.push(`SUBTOTAL: ${formatCents(receipt.subtotalCents ?? receipt.totalCents + receipt.discountCents)}`);
    lines.push(`DISCOUNT: -${formatCents(receipt.discountCents)}`);
  }
  if (receipt.pointsRedeemed && receipt.pointsRedeemed > 0) {
    lines.push(`POINTS USED (${receipt.pointsRedeemed}): -${formatCents(receipt.pointsRedeemedCents ?? 0)}`);
  }
  if (receipt.taxCents && receipt.taxCents > 0) {
    lines.push(`TAX (${receipt.taxRatePercent}%): ${formatCents(receipt.taxCents)}`);
  }
  lines.push(`TOTAL: ${formatCents(receipt.totalCents)}`);
  for (const payment of receipt.payments) {
    lines.push(formatPaymentLine(payment));
    const merchantId = merchantIdFor(receipt, payment.method);
    if (merchantId) lines.push(`  Merchant ID ${merchantId}`);
  }
  if (receipt.balanceDueCents && receipt.balanceDueCents > 0) {
    lines.push('');
    lines.push(`*** BALANCE DUE: ${formatCents(receipt.balanceDueCents)} ***`);
    // The name is on the line itself, not only in the CUSTOMER block below: this
    // is the half of the receipt that will be handed back over the counter when
    // they come to pay, and it has to say whose debt it is on its own.
    if (receipt.customer.name) lines.push(`Owed by ${receipt.customer.name}`);
  }
  if (receipt.customer.name || receipt.customer.phone || receipt.customer.email) {
    lines.push('');
    lines.push('CUSTOMER');
    if (receipt.customer.name) lines.push(receipt.customer.name);
    if (receipt.customer.phone) lines.push(receipt.customer.phone);
    if (receipt.customer.email) lines.push(receipt.customer.email);
    if (receipt.pointsEarned && receipt.pointsEarned > 0) lines.push(`Points earned: ${receipt.pointsEarned}`);
  }
  if (receipt.returnPolicy && receipt.returnPolicy.trim()) {
    lines.push('');
    lines.push(receipt.returnPolicy.trim());
  }
  lines.push('');
  lines.push('Thank you for your purchase!');
  return lines.join('\n');
}

// A self-contained 80mm thermal-tape receipt — used for Print (rendered into a
// hidden iframe, then window.print()) and for the PDF that Email and Share
// attach, so a saved receipt is the same object as a printed one.
//
// Shaped for the roll it comes off: monospace throughout so the item columns
// line up on a printer with no proportional font to fall back on, dashed rules
// instead of boxes, and pure black on white — a thermal head has one colour and
// no greys, so anything mid-tone prints as dither or vanishes.
//
// Everything is inline: no stylesheet link, no font URL, no remote image. The
// print iframe and expo-print's printToFileAsync both render this string
// detached from the app, where any external reference silently fails to load.
export function buildReceiptHtml(receipt: ReceiptData): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const money = (cents: number) => formatCents(cents).replace(/^\$/, '');

  const itemRows = receipt.items
    .map((line) => {
      const gross = line.unitPriceCents * line.quantity;
      const discount = line.discountCents ?? 0;
      // The discount rides under the item name rather than taking a row of its
      // own — on 80mm the name column is the only one with room to spare.
      const discountNote = discount > 0
        ? `<span class="item-sub">discount &minus;${money(discount)}</span>`
        : '';
      return `<tr>
        <td class="item-name">${esc(line.name)}${discountNote}</td>
        <td class="num qty">${line.quantity}</td>
        <td class="num price">${money(line.unitPriceCents)}</td>
        <td class="num total">${money(gross - discount)}</td>
      </tr>`;
    })
    .join('');

  const hasDiscount = Boolean(receipt.discountCents && receipt.discountCents > 0);
  const hasTax = Boolean(receipt.taxCents && receipt.taxCents > 0);
  const hasPoints = Boolean(receipt.pointsRedeemed && receipt.pointsRedeemed > 0);
  const summaryRows = [
    hasDiscount
      ? `<div class="row"><span class="label">Subtotal</span><span class="value">${money(receipt.subtotalCents ?? receipt.totalCents + (receipt.discountCents ?? 0))}</span></div>
         <div class="row"><span class="label">Discount</span><span class="value">&minus;${money(receipt.discountCents ?? 0)}</span></div>`
      : '',
    hasPoints
      ? `<div class="row"><span class="label">Points used (${receipt.pointsRedeemed})</span><span class="value">&minus;${money(receipt.pointsRedeemedCents ?? 0)}</span></div>`
      : '',
    hasTax
      ? `<div class="row"><span class="label">Tax (${receipt.taxRatePercent}%)</span><span class="value">${money(receipt.taxCents ?? 0)}</span></div>`
      : '',
  ].join('');

  const paymentRows = receipt.payments
    .map((p) => {
      const hasCurrency = p.currencyCode && p.foreignAmountCents !== null && p.exchangeRate !== null;
      const label = hasCurrency ? `${methodLabel(p.method)} (${esc(p.currencyCode as string)})` : methodLabel(p.method);
      const change = hasCurrency && p.foreignChangeCents && p.foreignChangeCents > 0
        ? ` &middot; change ${esc(formatForeignCents(p.foreignChangeCents, p.currencyCode as string))}`
        : '';
      const currencyNote = hasCurrency
        ? `<div class="sub">${esc(formatForeignCents(p.foreignAmountCents as number, p.currencyCode as string))} @ ${p.exchangeRate}/$${change}</div>`
        : '';
      const merchantId = merchantIdFor(receipt, p.method);
      const merchantNote = merchantId ? `<div class="sub">Merchant ID ${esc(merchantId)}</div>` : '';
      return `<div class="row"><span class="label">${label}</span><span class="value">${formatCents(p.amountCents)}</span></div>${currencyNote}${merchantNote}`;
    })
    .join('');

  // Boxed, not just another row: this is the one number on the paper that means
  // the transaction is not finished, and it has to survive being glanced at.
  const balanceDueBlock = receipt.balanceDueCents && receipt.balanceDueCents > 0
    ? `<div class="balance-due">
         <div class="row"><span>BALANCE DUE</span><span>${formatCents(receipt.balanceDueCents)}</span></div>
         ${receipt.customer.name ? `<div class="balance-owed-by">Owed by ${esc(receipt.customer.name)}</div>` : ''}
       </div>`
    : '';

  const hasCustomer = Boolean(receipt.customer.name || receipt.customer.phone || receipt.customer.email);
  const customerBlock = hasCustomer
    ? `<div class="dashed"></div>
       <div class="section-label">Customer</div>
       ${receipt.customer.name ? `<div class="customer">${esc(receipt.customer.name)}</div>` : ''}
       ${receipt.customer.phone ? `<div class="customer">${esc(receipt.customer.phone)}</div>` : ''}
       ${receipt.customer.email ? `<div class="customer">${esc(receipt.customer.email)}</div>` : ''}
       ${receipt.pointsEarned && receipt.pointsEarned > 0 ? `<div class="customer">Points earned: ${receipt.pointsEarned}</div>` : ''}`
    : '';

  // The code line and the QR appear together or not at all — a printed number
  // with no scannable code beside it invites someone to type a uuid by hand.
  const codeRow = receipt.saleId
    ? `<div class="row"><span class="label">Receipt #</span><span class="value">${receiptShortCode(receipt.saleId)}</span></div>`
    : '';
  const qrBlock = receipt.saleId
    ? `<div class="qr">${qrSvg(receiptPayload(receipt.saleId), 62)}<div class="qr-num">${receiptShortCode(receipt.saleId)}</div></div>`
    : '';

  const location = formatLocation(receipt);
  const when = new Date(receipt.createdAt);
  const policy = receipt.returnPolicy && receipt.returnPolicy.trim()
    ? `<div class="policy">${esc(receipt.returnPolicy.trim())}</div>`
    : '';
  const branding = receipt.showKaiibiBranding === false
    ? ''
    : `<div class="powered-by">
         <span class="pb-text">Powered by</span>
         <img class="pb-mark" src="${KAIIBI_MARK_DATA_URI}" alt="Kaiibi" />
         <span class="pb-name">Kaiibi</span>
       </div>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Receipt</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  .receipt {
    width: 80mm;
    margin: 0 auto;
    padding: 22px 16px 14px;
    background: #FFFFFF;
    color: #111111;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", "Courier New", monospace;
    font-size: 11.5px;
    line-height: 1.55;
    /* Item columns only line up if the digits are all one width. */
    font-variant-numeric: tabular-nums;
  }
  .center { text-align: center; }
  .logo { width: 46px; height: 46px; object-fit: contain; display: block; margin: 0 auto 8px; }
  .shop-name { font-size: 17px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; line-height: 1.25; margin-bottom: 3px; }
  .store-name { font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; color: #333333; margin-bottom: 6px; }
  .shop-meta { font-size: 10.5px; color: #333333; margin: 1px 0; }
  /* A gradient rather than border-style: dashed — browsers each pick their own
     dash length for the latter, so the rule looked different in the print
     preview and the PDF. This one is the same everywhere. */
  .dashed { height: 1px; margin: 11px 0; background-image: repeating-linear-gradient(to right, #8F8F8F 0 4px, transparent 4px 9px); }
  .rule-under-head { height: 1px; margin-bottom: 2px; background-image: repeating-linear-gradient(to right, #8F8F8F 0 3px, transparent 3px 7px); }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 2px 0; }
  .row .label { color: #333333; }
  .row .value { text-align: right; white-space: nowrap; }
  table.items { width: 100%; border-collapse: collapse; margin: 4px 0 2px; font-size: 11px; }
  table.items th { text-align: left; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; padding-bottom: 5px; }
  table.items th.num, table.items td.num { text-align: right; white-space: nowrap; }
  table.items th.qty, table.items td.qty { width: 3ch; }
  table.items th.price, table.items td.price { width: 7ch; }
  table.items th.total, table.items td.total { width: 7ch; }
  table.items td { padding: 4px 0 0; vertical-align: top; }
  table.items td.item-name { padding-right: 8px; word-break: break-word; }
  .item-sub { display: block; font-size: 9.5px; color: #666666; }
  .totals { margin-top: 8px; font-size: 11.5px; }
  .totals .row.grand { font-size: 15px; font-weight: 700; margin-top: 8px; padding-top: 9px; border-top: 1.5px solid #111111; letter-spacing: 0.5px; }
  .payment { font-size: 10.5px; color: #333333; }
  .payment .sub { font-size: 9.5px; color: #666666; margin: 0 0 2px; }
  .section-label { font-size: 9.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #666666; margin-bottom: 3px; }
  .customer { font-size: 10.5px; color: #333333; }
  .qr { text-align: center; margin: 14px 0 4px; }
  .qr svg { display: block; margin: 0 auto; }
  .qr-num { font-size: 9.5px; letter-spacing: 2.5px; margin-top: 6px; color: #333333; }
  /* Same type scale and monospace as every other line -- the receipt design does
     not change, it gains a line. The box is a 1.5px rule to match .row.grand,
     because this is the second figure on the paper that carries that weight. */
  .balance-due { border: 1.5px solid #111111; padding: 7px 8px; margin: 9px 0 3px; }
  .balance-due .row { display: flex; justify-content: space-between; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; }
  .balance-owed-by { font-size: 10.5px; margin-top: 3px; }
  .thanks { text-align: center; font-size: 11.5px; font-weight: 700; letter-spacing: 0.5px; margin: 12px 0 3px; }
  .policy { text-align: center; font-size: 9.5px; line-height: 1.45; color: #555555; margin-bottom: 3px; }
  .powered-by { display: flex; align-items: center; justify-content: center; gap: 5px; margin-top: 14px; padding-top: 11px; background-image: repeating-linear-gradient(to right, #8F8F8F 0 4px, transparent 4px 9px); background-size: 100% 1px; background-repeat: no-repeat; background-position: top left; }
  .pb-text { font-size: 9.5px; color: #888888; letter-spacing: 0.3px; }
  /* print-color-adjust: the mark is a white K on a black square, and browsers
     drop background graphics by default when printing — without this it comes
     out as an empty box. */
  .pb-mark { width: 14px; height: 14px; object-fit: contain; display: block; border-radius: 3px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .pb-name { font-size: 10.5px; font-weight: 700; letter-spacing: 0.4px; color: #111111; }
</style>
</head>
<body>
  <div class="receipt">
    <div class="center">
      ${receipt.shopLogoUrl ? `<img class="logo" src="${esc(receipt.shopLogoUrl)}" alt="" />` : ''}
      <div class="shop-name">${esc(receipt.shopName)}</div>
      ${receipt.locationName ? `<div class="store-name">${esc(receipt.locationName)}</div>` : ''}
      ${location ? `<div class="shop-meta">${esc(location)}</div>` : ''}
      ${receipt.shopContactPhone ? `<div class="shop-meta">${esc(receipt.shopContactPhone)}</div>` : ''}
      ${receipt.shopHours ? `<div class="shop-meta">${esc(receipt.shopHours)}</div>` : ''}
    </div>

    <div class="dashed"></div>

    ${codeRow}
    <div class="row"><span class="label">Date</span><span class="value">${when.toLocaleDateString()}</span></div>
    <div class="row"><span class="label">Time</span><span class="value">${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
    ${receipt.cashierName ? `<div class="row"><span class="label">Cashier</span><span class="value">${esc(receipt.cashierName)}</span></div>` : ''}

    <div class="dashed"></div>

    <table class="items">
      <thead><tr><th>Item</th><th class="num qty">Qty</th><th class="num price">Price</th><th class="num total">Total</th></tr></thead>
    </table>
    <div class="rule-under-head"></div>
    <table class="items"><tbody>${itemRows}</tbody></table>

    <div class="totals">
      ${summaryRows}
      <div class="row grand"><span>TOTAL</span><span>${formatCents(receipt.totalCents)}</span></div>
    </div>

    <div class="dashed"></div>

    <div class="payment">${paymentRows}</div>
    ${balanceDueBlock}
    ${customerBlock}
    ${qrBlock}

    <div class="thanks">THANK YOU FOR YOUR PURCHASE!</div>
    ${policy}
    ${branding}
  </div>
</body>
</html>`;
}
