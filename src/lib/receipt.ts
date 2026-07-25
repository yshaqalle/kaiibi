import { formatCents } from '@/lib/currency';
import { methodLabel } from '@/lib/payment-methods';
import type { PaymentLine, Sale } from '@/types/models';

// A lighter shape than `CartLine`/`SaleItem` — just what a receipt needs to
// print a line, so both a fresh POS cart and a historical `Sale` (whose
// items reference a product that may since have been renamed or deleted)
// can build one the same way.
export type ReceiptItem = { name: string; quantity: number; unitPriceCents: number; discountCents?: number };

export type ReceiptData = {
  shopName: string;
  shopLogoUrl: string | null;
  shopCity: string | null;
  shopNeighborhood: string | null;
  shopContactPhone: string | null;
  // Who rang up the sale, if a cashier profile was picked in the POS — see
  // migration 0009. Optional: most shops are a single owner running the
  // register themselves.
  cashierName: string | null;
  // Printed at the bottom of the receipt, below "Thank you" — set in
  // Settings and applies to every sale, not captured per-sale.
  returnPolicy: string | null;
  items: ReceiptItem[];
  payments: PaymentLine[];
  customer: { name: string | null; phone: string | null; email: string | null };
  // Gross (pre-discount) total and the total discount taken off it — both
  // optional/omittable so a receipt with no discount at all can skip the
  // breakdown and just show the total, same as before this feature existed.
  subtotalCents?: number;
  discountCents?: number;
  totalCents: number;
  createdAt: string;
};

function formatLocation(receipt: Pick<ReceiptData, 'shopCity' | 'shopNeighborhood'>): string | null {
  const parts = [receipt.shopCity, receipt.shopNeighborhood].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Reconstructs a receipt for a past sale — so a customer who comes back
// later asking for their receipt again can be helped from the Sales screen,
// not just right after checkout.
export function buildReceiptFromSale(
  sale: Sale,
  shop: { name: string; logoUrl: string | null; city: string | null; neighborhood: string | null; contactPhone: string | null; returnPolicy: string | null }
): ReceiptData {
  const subtotalCents = (sale.items ?? []).reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  return {
    shopName: shop.name,
    shopLogoUrl: shop.logoUrl,
    shopCity: shop.city,
    shopNeighborhood: shop.neighborhood,
    shopContactPhone: shop.contactPhone,
    cashierName: sale.cashierName,
    returnPolicy: shop.returnPolicy,
    items: (sale.items ?? []).map((item) => ({ name: item.productName, quantity: item.quantity, unitPriceCents: item.unitPriceCents, discountCents: item.discountCents })),
    payments: (sale.payments ?? []).map((p) => ({ method: p.method, amountCents: p.amountCents, tenderedCents: p.tenderedCents, customerName: p.customerName, customerPhone: p.customerPhone })),
    customer: { name: sale.customerName, phone: sale.customerPhone, email: sale.customerEmail },
    subtotalCents,
    discountCents: subtotalCents - sale.totalCents,
    totalCents: sale.totalCents,
    createdAt: sale.createdAt,
  };
}

// Plain text — used for the Email body and the WhatsApp prefilled message,
// where markup would either be stripped or shown as literal tags.
export function buildReceiptText(receipt: ReceiptData): string {
  const lines: string[] = [];
  lines.push(receipt.shopName);
  const location = formatLocation(receipt);
  if (location) lines.push(location);
  if (receipt.shopContactPhone) lines.push(receipt.shopContactPhone);
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
  lines.push(`TOTAL: ${formatCents(receipt.totalCents)}`);
  for (const payment of receipt.payments) {
    lines.push(`${methodLabel(payment.method)}: ${formatCents(payment.amountCents)}`);
  }
  if (receipt.customer.name || receipt.customer.phone || receipt.customer.email) {
    lines.push('');
    lines.push('CUSTOMER');
    if (receipt.customer.name) lines.push(receipt.customer.name);
    if (receipt.customer.phone) lines.push(receipt.customer.phone);
    if (receipt.customer.email) lines.push(receipt.customer.email);
  }
  if (receipt.returnPolicy && receipt.returnPolicy.trim()) {
    lines.push('');
    lines.push(receipt.returnPolicy.trim());
  }
  lines.push('');
  lines.push('Thank you for your purchase!');
  return lines.join('\n');
}

// A small self-contained HTML page — used for both Print (opened in a new
// tab, then window.print()) and Save (downloaded as a .html file), so a
// saved receipt looks the same as a printed one.
export function buildReceiptHtml(receipt: ReceiptData): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const itemRows = receipt.items
    .map((line) => {
      const gross = line.unitPriceCents * line.quantity;
      const discount = line.discountCents ?? 0;
      const discountLine = discount > 0 ? `<div class="row muted"><span>&nbsp;&nbsp;discount</span><span>-${formatCents(discount)}</span></div>` : '';
      return `<div class="row"><span>${line.quantity} &times; ${esc(line.name)}</span><span>${formatCents(gross - discount)}</span></div>${discountLine}`;
    })
    .join('');

  const hasDiscount = Boolean(receipt.discountCents && receipt.discountCents > 0);
  const summaryRows = hasDiscount
    ? `<div class="row muted"><span>Subtotal</span><span>${formatCents(receipt.subtotalCents ?? receipt.totalCents + (receipt.discountCents ?? 0))}</span></div>
       <div class="row muted"><span>Discount</span><span>-${formatCents(receipt.discountCents ?? 0)}</span></div>`
    : '';

  const paymentRows = receipt.payments
    .map((p) => `<div class="row muted"><span>${methodLabel(p.method)}</span><span>${formatCents(p.amountCents)}</span></div>`)
    .join('');

  const customerBlock = receipt.customer.name || receipt.customer.phone || receipt.customer.email
    ? `<div class="divider"></div><div class="label">CUSTOMER</div>
       ${receipt.customer.name ? `<div class="muted">${esc(receipt.customer.name)}</div>` : ''}
       ${receipt.customer.phone ? `<div class="muted">${esc(receipt.customer.phone)}</div>` : ''}
       ${receipt.customer.email ? `<div class="muted">${esc(receipt.customer.email)}</div>` : ''}`
    : '';

  const location = formatLocation(receipt);

  const returnPolicyBlock = receipt.returnPolicy && receipt.returnPolicy.trim()
    ? `<div class="divider"></div><div class="policy">${esc(receipt.returnPolicy.trim())}</div>`
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Receipt</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; background: #FFFFFF; margin: 0; padding: 24px 16px; color: #111111; display: flex; justify-content: center; }
  .card { width: 100%; max-width: 380px; background: #F3F2ED; border-radius: 16px; padding: 22px 20px; }
  .head { text-align: center; margin-bottom: 4px; }
  .logo { display: block; width: 52px; height: 52px; object-fit: cover; border-radius: 12px; margin: 0 auto 10px; }
  .shop { font-size: 18px; font-weight: 800; letter-spacing: 0.2px; }
  .muted { color: #777777; font-size: 12px; margin-top: 2px; }
  .divider { border-top: 1.5px dashed #D9D9D3; margin: 16px 0; }
  .row { display: flex; justify-content: space-between; align-items: center; font-size: 14px; margin: 5px 0; }
  .row.muted span { color: #666666; font-size: 13px; }
  .row span:first-child { color: #333333; }
  .row span:last-child { font-weight: 700; }
  .total { background: #111111; color: #FFFFFF; border-radius: 10px; padding: 10px 14px; margin-bottom: 4px; }
  .total span { font-weight: 800; }
  .total span:first-child { color: #FFFFFF; font-size: 14px; letter-spacing: 0.3px; }
  .total span:last-child { color: #FFFFFF; font-size: 17px; }
  .label { font-size: 10px; font-weight: 800; letter-spacing: 0.5px; color: #999999; margin: 2px 0 4px; }
  .policy { color: #777777; font-size: 11px; line-height: 1.5; }
  .thanks { margin-top: 18px; text-align: center; color: #999999; font-size: 12px; font-weight: 700; letter-spacing: 0.3px; }
  @media print { body { padding: 0; } .card { border-radius: 0; max-width: 100%; } }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      ${receipt.shopLogoUrl ? `<img class="logo" src="${esc(receipt.shopLogoUrl)}" alt="" />` : ''}
      <div class="shop">${esc(receipt.shopName)}</div>
      ${location ? `<div class="muted">${esc(location)}</div>` : ''}
      ${receipt.shopContactPhone ? `<div class="muted">${esc(receipt.shopContactPhone)}</div>` : ''}
      <div class="muted">${esc(new Date(receipt.createdAt).toLocaleString())}</div>
      ${receipt.cashierName ? `<div class="muted">Served by ${esc(receipt.cashierName)}</div>` : ''}
    </div>
    <div class="divider"></div>
    ${itemRows}
    <div class="divider"></div>
    ${summaryRows}
    <div class="row total"><span>Total</span><span>${formatCents(receipt.totalCents)}</span></div>
    ${paymentRows}
    ${customerBlock}
    ${returnPolicyBlock}
    <div class="thanks">Thank you for your purchase!</div>
  </div>
</body>
</html>`;
}
