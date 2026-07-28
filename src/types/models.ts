export type PaymentMethod = 'cash' | 'zaad' | 'edahab' | 'other';

export type Profile = {
  id: string;
  role: 'owner' | 'customer';
  fullName: string | null;
  phone: string | null;
  createdAt: string;
};

export type Shop = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  city: string | null;
  neighborhood: string | null;
  contactPhone: string | null;
  // Printed on receipts (Print/Save/Email/WhatsApp) — see src/lib/receipt.ts.
  returnPolicy: string | null;
  // Shown in the owner sidebar avatar and on receipts.
  logoUrl: string | null;
  categories: string[];
  // Set in Settings; drives the dashboard's monthly revenue goal meter. Null
  // until the owner sets one — the meter is hidden until then.
  monthlyRevenueGoalCents: number | null;
  // Shop-wide tax, off by default. When enabled, `taxRatePercent` (default
  // 2.5, editable) is applied server-side to every sale's post-discount
  // subtotal — see complete_sale/edit_sale in migration 0015.
  taxEnabled: boolean;
  taxRatePercent: number;
  createdAt: string;
};

// An alternate currency a shop accepts as a way to settle a payment line
// (see PaymentLine below) — USD itself is not a row here, it's the
// implicit default when a payment's currencyCode is null. `rateToUsd` is
// units of this currency per $1 USD (e.g. 115 for Somaliland Shilling).
export type Currency = {
  id: string;
  shopId: string;
  code: string;
  name: string;
  symbol: string;
  rateToUsd: number;
  active: boolean;
  createdAt: string;
};

export type Product = {
  id: string;
  shopId: string;
  name: string;
  description: string | null;
  sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  tags: string[];
  supplierName: string | null;
  costCents: number | null;
  priceCents: number;
  stock: number;
  reorderLevel: number | null;
  shelfNumber: string | null;
  expiryDate: string | null;
  batchNumber: string | null;
  imageUrl: string | null;
  isListedOnline: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NewProductInput = Omit<Product, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>;

// `value` is a percentage (0-100) for 'percentage', or a cents amount for
// 'fixed'. Used both for a manual per-line discount the cashier types into
// the POS cart, and for a `Promotion`'s configured discount.
export type Discount = { type: 'percentage'; value: number } | { type: 'fixed'; value: number };

export type CartLine = {
  product: Product;
  quantity: number;
  // Set when the cashier overrides/enters a discount directly on this cart
  // line in the POS — takes precedence over any auto-applied `Promotion`
  // for the same line (see src/lib/discounts.ts).
  manualDiscount?: Discount | null;
};

// A "sale"/promotion the owner configures in Settings — auto-applies to
// any matching cart line in the POS (see src/lib/discounts.ts) unless the
// cashier enters a manual override for that line.
export type Promotion = {
  id: string;
  shopId: string;
  name: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  scope: 'store' | 'brand' | 'category';
  // The brand or category name for those two scopes; null for 'store'.
  scopeValue: string | null;
  active: boolean;
  createdAt: string;
};

export type SaleItem = {
  id: string;
  saleId: string;
  productId: string | null;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  // How much was knocked off this line (already reflected in
  // `lineTotalCents`) — kept separately so receipts/history can show it.
  discountCents: number;
};

// One line of a (possibly split) checkout payment. `tenderedCents` is only
// meaningful for cash (what the customer physically handed over, so change
// due = tenderedCents - amountCents); `customerName`/`customerPhone` are
// only meaningful for mobile-money methods like ZAAD/e-Dahab.
// `amountCents` is always the USD-cents amount applied to the sale, even
// when this line was settled in a foreign currency — `currencyCode`
// through `foreignChangeCents` are display/audit-only for that case, all
// null for a plain USD payment.
export type PaymentLine = {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents: number | null;
  customerName: string | null;
  customerPhone: string | null;
  currencyCode: string | null;
  exchangeRate: number | null;
  foreignAmountCents: number | null;
  foreignChangeCents: number | null;
};

export type SalePayment = PaymentLine & {
  id: string;
  saleId: string;
  createdAt: string;
};

// A snapshotted line item inside a `SaleEdit.previousSnapshot` — same shape
// as `SaleItem` but without an id/saleId, since it's frozen history rather
// than a live row.
export type SaleItemSnapshot = {
  productId: string | null;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
  discountCents: number;
};

// The full pre-edit state of a sale, captured atomically by `edit_sale`
// before applying a change — this is what "each update is kept and shown"
// means: the entire previous version, not a field-level diff.
export type SaleEdit = {
  id: string;
  saleId: string;
  editedBy: string | null;
  createdAt: string;
  previousSnapshot: {
    totalCents: number;
    itemCount: number;
    paymentMethod: PaymentMethod;
    customerName: string | null;
    customerPhone: string | null;
    customerEmail: string | null;
    discountCents: number;
    items: SaleItemSnapshot[];
    payments: PaymentLine[];
  };
};

export type Sale = {
  id: string;
  shopId: string;
  createdBy: string | null;
  paymentMethod: PaymentMethod;
  paymentNote: string | null;
  // Who the sale was for, independent of payment method — unlike
  // `SalePayment.customerName/customerPhone` (only meaningful for
  // ZAAD/e-Dahab payment lines), this applies to any sale regardless of how
  // it was paid, including cash.
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  // Who rang up the sale — a frozen snapshot of a `Cashier` profile's name
  // at checkout time, not a live reference (renaming/deleting the profile
  // later doesn't change past sales, same as customer info).
  cashierName: string | null;
  // Whole-transaction discount entered at checkout, on top of any per-line
  // discounts (already reflected in each item's `lineTotalCents`) — see
  // src/lib/discounts.ts.
  discountCents: number;
  // Tax applied on top of the post-discount subtotal, and the rate that
  // produced it — both a frozen snapshot at sale time (see migration
  // 0015), independent of the shop's tax settings changing later.
  taxCents: number;
  taxRatePercent: number | null;
  totalCents: number;
  itemCount: number;
  createdAt: string;
  items?: SaleItem[];
  payments?: SalePayment[];
  edits?: SaleEdit[];
};

export type Category = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  description: string | null;
  imageUrl: string | null;
  createdAt: string;
};

export type Brand = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  description: string | null;
  imageUrl: string | null;
  createdAt: string;
};

export type Tag = {
  id: string;
  shopId: string;
  name: string;
  color: string | null;
  createdAt: string;
};

export type Cashier = {
  id: string;
  shopId: string;
  name: string;
  createdAt: string;
};
