import { formatCents } from '@/lib/currency';
import { methodLabel } from '@/lib/payment-methods';
import type { PaymentLine, Sale } from '@/types/models';

// A lighter shape than `CartLine`/`SaleItem` — just what a receipt needs to
// print a line, so both a fresh POS cart and a historical `Sale` (whose
// items reference a product that may since have been renamed or deleted)
// can build one the same way.
export type ReceiptItem = { name: string; quantity: number; unitPriceCents: number };

export type ReceiptData = {
  shopName: string;
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
  shop: { name: string; city: string | null; neighborhood: string | null; contactPhone: string | null; returnPolicy: string | null }
): ReceiptData {
  return {
    shopName: shop.name,
    shopCity: shop.city,
    shopNeighborhood: shop.neighborhood,
    shopContactPhone: shop.contactPhone,
    cashierName: sale.cashierName,
    returnPolicy: shop.returnPolicy,
    items: (sale.items ?? []).map((item) => ({ name: item.productName, quantity: item.quantity, unitPriceCents: item.unitPriceCents })),
    payments: (sale.payments ?? []).map((p) => ({ method: p.method, amountCents: p.amountCents, tenderedCents: p.tenderedCents, customerName: p.customerName, customerPhone: p.customerPhone })),
    customer: { name: sale.customerName, phone: sale.customerPhone, email: sale.customerEmail },
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
    lines.push(`${line.quantity} x ${line.name} - ${formatCents(line.unitPriceCents * line.quantity)}`);
  }
  lines.push('');
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
    .map((line) => `<div class="row"><span>${line.quantity} &times; ${esc(line.name)}</span><span>${formatCents(line.unitPriceCents * line.quantity)}</span></div>`)
    .join('');

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

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Receipt</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 380px; margin: 24px auto; padding: 0 16px; color: #111111; }
  .shop { font-size: 18px; font-weight: 800; }
  .muted { color: #666666; font-size: 13px; margin-top: 2px; }
  .divider { border-top: 1px solid #ECECEC; margin: 14px 0; }
  .row { display: flex; justify-content: space-between; font-size: 14px; margin: 4px 0; }
  .row.muted span { color: #666666; font-size: 13px; }
  .total span { font-weight: 800; font-size: 16px; }
  .label { font-size: 11px; font-weight: 800; letter-spacing: 0.5px; color: #999999; margin-bottom: 4px; }
  .thanks { margin-top: 20px; text-align: center; color: #999999; font-size: 13px; }
  @media print { body { margin: 0 auto; } }
</style>
</head>
<body>
  <div class="shop">${esc(receipt.shopName)}</div>
  ${location ? `<div class="muted">${esc(location)}</div>` : ''}
  ${receipt.shopContactPhone ? `<div class="muted">${esc(receipt.shopContactPhone)}</div>` : ''}
  <div class="muted">${esc(new Date(receipt.createdAt).toLocaleString())}</div>
  ${receipt.cashierName ? `<div class="muted">Served by ${esc(receipt.cashierName)}</div>` : ''}
  <div class="divider"></div>
  ${itemRows}
  <div class="divider"></div>
  <div class="row total"><span>Total</span><span>${formatCents(receipt.totalCents)}</span></div>
  ${paymentRows}
  ${customerBlock}
  <div class="thanks">Thank you for your purchase!</div>
</body>
</html>`;
}
