import type { PayCadence } from '@/lib/pay-periods';
import type { OpeningHours } from '@/lib/store-hours';

export type PaymentMethod = 'cash' | 'zaad' | 'edahab' | 'other';

// What a SALE's summary column can say, which is one more thing than a payment
// picker can offer: 'unpaid' is not a way to pay, it is the absence of one, on a
// sale taken on credit against a customer (migration 20260831000100). Kept out
// of PaymentMethod deliberately -- expenses and recurring bills use that list
// and money going out is never unpaid.
export type SalePaymentMethod = PaymentMethod | 'unpaid';

export type Profile = {
  id: string;
  role: 'admin' | 'customer' | 'staff';
  fullName: string | null;
  phone: string | null;
  // Set by Settings → Security's Change Password flow (see lib/profile.ts's
  // markPasswordChanged) — only reflects changes made there, not a reset
  // via a forgot-password email link.
  passwordChangedAt: string | null;
  createdAt: string;
};

export type Shop = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  // No address here on purpose: a business doesn't have a street, its branches
  // do. City/neighborhood/phone live on `ShopLocation` — see migration
  // 20260811000000. A one-branch shop edits them under Settings → Store, which
  // writes them to its primary location.
  // Printed on receipts (Print/Save/Email/WhatsApp) — see src/lib/receipt.ts.
  returnPolicy: string | null;
  // Shown in the admin sidebar avatar and on receipts.
  logoUrl: string | null;
  // The shop's own colour, used by the poster (src/components/marketing/
  // poster-canvas.tsx). Null means "never set" -- the poster falls back to its
  // template's own colour rather than to black. The text colour that goes on it
  // is computed, never stored: see src/lib/contrast.ts.
  brandColor: string | null;
  categories: string[];
  // Start date the weekly/biweekly pay cycles count from. Null until set; the
  // period picker asks for it rather than guessing, because a defaulted anchor
  // would silently choose everyone's pay days.
  payPeriodAnchor: string | null;
  // Shop-wide tax, off by default. When enabled, `taxRatePercent` (default
  // 2.5, editable) is applied server-side to every sale's post-discount
  // subtotal — see complete_sale/edit_sale in migration 0015.
  taxEnabled: boolean;
  taxRatePercent: number;
  // Customer loyalty points, off by default. `loyaltyPointsPerUsd` is how many
  // points a dollar of pre-tax, post-discount spend earns; `loyaltyCentsPerPoint`
  // is what a point is worth back when spent at checkout. The two are separate
  // because their product is what the programme costs — see migration
  // 20260820000000 and src/lib/loyalty.ts.
  loyaltyEnabled: boolean;
  loyaltyPointsPerUsd: number;
  loyaltyCentsPerPoint: number;
  // How long earned points wait before they can be spent, in days. Default 1.
  // Zero re-opens the buy-earn-spend-return loop the window exists to close —
  // see migration 20260820000100.
  loyaltyPointsAvailableAfterDays: number;
  // Receipt customization — see src/lib/receipt.ts (show-logo/show-cashier
  // name) and src/components/receipt-modal.tsx (auto-print/auto-whatsapp).
  receiptShowLogo: boolean;
  receiptShowCashierName: boolean;
  receiptAutoPrint: boolean;
  receiptAutoWhatsapp: boolean;
  // Which payment methods the POS offers at checkout, and whether a sale
  // can combine more than one — see src/components/payment-method-picker.tsx.
  paymentCashEnabled: boolean;
  paymentZaadEnabled: boolean;
  paymentEdahabEnabled: boolean;
  paymentSplitEnabled: boolean;
  // Note values the drawer tally offers, keyed by currency code, in that
  // currency's minor unit: {"USD": [10000, ...], "SLSH": [1000000, ...]}.
  // A starting point, not a constraint — the tally accepts values not listed
  // here, because a seeded list is guaranteed to be wrong somewhere.
  cashDenominations: Record<string, number[]>;
  // Notification preferences (Settings → Notifications). These are
  // currently preferences only — nothing in the app sends a daily summary,
  // low-stock alert, or push/email/WhatsApp notification yet, so toggling
  // these has no effect beyond being saved. See docs/backlog for what
  // building real delivery would take.
  notifyDailySummary: boolean;
  notifyLargeSale: boolean;
  notifyLowStock: boolean;
  notifyOutOfStock: boolean;
  notifyViaPush: boolean;
  notifyViaEmail: boolean;
  notifyViaWhatsapp: boolean;
  // Inventory alert thresholds (Settings → Inventory alerts). Replaces the
  // previous hardcoded fallback of 5 used when a product has no per-product
  // `reorderLevel` — see getLowStockProducts/ProductTile/ProductTableRow.
  defaultLowStockLevel: number;
  // Expiry tracking only ever applies to products that already have their
  // own `expiryDate` set — see getExpiringProducts (lib/products.ts).
  expiryTrackingEnabled: boolean;
  expiryWarningLeadDays: number;
  createdAt: string;
};

// A physical store. `Shop` is the business (the tenant every shop_id points
// at); this is one of the places it trades from. A shop always has at least
// one — migration 20260808000000 backfills a primary "Main" carrying the
// address the shop row already held — so consumers never have to handle a
// shop with no location.
export type ShopLocation = {
  id: string;
  shopId: string;
  name: string;
  // Short, stable branch identifier ("002", "AR"). Optional — a small shop
  // needs only the name. Used where a rename must not break the reference
  // (imports, exports, per-branch accounting rows), never on a customer
  // receipt. Distinct from the unit number inside `address`.
  code: string | null;
  city: string | null;
  neighborhood: string | null;
  address: string | null;
  contactPhone: string | null;
  // Weekly opening hours for THIS branch. `{}` means nobody has set them, which
  // renders as nothing rather than as "closed all week". Lived on `Shop` until
  // migration 20260809000000 moved it here — hours belong to a place, and two
  // branches rarely keep the same ones.
  openingHours: OpeningHours;
  // This store's monthly revenue target. Null until set — the dashboard's goal
  // meter is hidden rather than showing a zero target. Lives here, not on the
  // business: a flagship and a kiosk don't share a target, and the
  // business-wide figure is the sum across stores (migration 20260813000000).
  monthlyRevenueGoalCents: number | null;
  // Whether this store scans barcodes, and how. Per store because a scanner is
  // a physical fact about a counter, not a business-wide policy — the flagship
  // has one wired to the till, the kiosk has a phone, the stockroom has neither
  // (migration 20260819000100).
  //
  // Camera scanning defaults on: it is additive, and a Scan button that
  // explains itself is better than a setting nobody finds. The hardware wedge
  // defaults OFF, because supporting those scanners means watching every
  // keystroke on the page — worth it where one is plugged in, pure risk where
  // one isn't.
  barcodeScanningEnabled: boolean;
  hardwareScannerEnabled: boolean;
  // Mobile-money merchant numbers, printed on a receipt under the payment line
  // that used them (migration 20260821000000). Per store for the same reason as
  // the phone above: `Shop.paymentZaadEnabled` says whether the business takes
  // ZAAD at all, this says which till at this branch receives it, and a shop
  // running three branches commonly runs three accounts.
  //
  // Null or empty both mean "not set" and print nothing.
  zaadMerchantId: string | null;
  edahabMerchantId: string | null;
  // Whether this branch's POS refuses to sell without an open register. Lives
  // here rather than on `Shop` for the reason the merchant ids do: a flagship
  // with three tills wants the drawer counted, the kiosk where the owner is the
  // only person behind the counter does not, and one business runs both. Off by
  // default — complete_sale enforces it server-side when on.
  requireOpenRegister: boolean;
  // Exactly one per shop. The fallback whenever a location isn't otherwise
  // resolvable — what a fresh device selects before anyone chooses.
  isPrimary: boolean;
  // A closed branch is deactivated, never deleted: its sales and shifts stay
  // readable. Inactive locations are hidden from the switcher.
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

// The scanner flags are optional on create: the database defaults them
// (camera on, wedge off), so the "add a store" form has no reason to ask about
// hardware before the store exists. They stay settable on the update patches
// that Settings sends.
//
// The merchant ids are optional for the same reason from the other direction:
// they have no default and start null, and asking for a ZAAD number while
// someone is still typing the branch name would be friction for a field most
// shops fill in later, if at all.
export type NewShopLocationInput = Omit<
  ShopLocation,
  | 'id'
  | 'shopId'
  | 'isPrimary'
  | 'createdAt'
  | 'updatedAt'
  | 'barcodeScanningEnabled'
  | 'hardwareScannerEnabled'
  | 'zaadMerchantId'
  | 'edahabMerchantId'
  | 'requireOpenRegister'
> &
  Partial<
    Pick<
      ShopLocation,
      | 'barcodeScanningEnabled'
      | 'hardwareScannerEnabled'
      | 'zaadMerchantId'
      | 'edahabMerchantId'
      // Never set while creating a branch: a store with no registers yet cannot
      // require one, so this is only ever turned on later, from the Registers
      // panel, once there is something to open.
      | 'requireOpenRegister'
    >
  >;

// How many units of a product sit at one branch. `Product.stock` is the sum of
// these across every location, maintained by trigger (migration
// 20260810000000) — writing to it directly has no effect, so this is the only
// representation that actually decides anything.
export type ProductLocationStock = {
  productId: string;
  locationId: string;
  stock: number;
  // Per-branch overrides of the product's own values. Null means "use the
  // product's" — a flagship branch can carry a deeper reorder level than a
  // kiosk, and the same item sits on a different shelf in each.
  reorderLevel: number | null;
  shelfNumber: string | null;
};

// A delivery that arrived at one store. Written only by the receive_stock RPC
// (migration 20260902000000) -- there is no write policy on the table, so a
// receipt always means units that actually landed.
export type StockReceipt = {
  id: string;
  shopId: string;
  locationId: string;
  // Free text, not a vendor FK: a delivery is usually logged by whoever opened
  // the box. Accounting's vendor list stays where a supplier becomes a record.
  supplierName: string | null;
  // The shop's handle on the delivery -- invoice number, waybill, PO.
  reference: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type StockReceiptItem = {
  id: string;
  receiptId: string;
  productId: string;
  // Frozen at receipt time, like SaleItem's productName.
  productName: string;
  quantity: number;
  // What THIS delivery charged per unit. Distinct from Product.costCents, which
  // the RPC overwrites with this value: that one is "what it costs me now",
  // this one is the record of a particular delivery and is never rewritten.
  unitCostCents: number | null;
};

// Why a shop believes a line came up short (or long). Five, and a closed set,
// because the count preview reports how many lines have NONE ("9 with no
// reason") and a sixth spelling would quietly become a sixth category. The
// database stores exactly these strings (migration 20260903000100).
//
// A missing reason is `null` and stays null. It is deliberately never defaulted
// to 'miscount': that is a precise-looking answer to a question nobody asked,
// and unexplained shrinkage is itself the finding a shop needs to see.
export type StockCountReason = 'damaged' | 'expired' | 'theft_or_loss' | 'miscount' | 'other';

// A stock-take at one store. Written only by the save_stock_count RPC
// (migration 20260903000100) -- there is no write policy on the table, so a
// count always means numbers that actually changed, and by whom.
export type StockCount = {
  id: string;
  shopId: string;
  locationId: string;
  // One note for the whole walk. The reasons are per line, below: one
  // stock-take finds different causes on different shelves.
  note: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type StockCountItem = {
  id: string;
  countId: string;
  productId: string;
  // Frozen at count time, like SaleItem's and StockReceiptItem's.
  productName: string;
  // What the app believed at the moment it was replaced. Without it the new
  // number alone cannot answer "who said these three were gone, and when?",
  // which is the whole reason this door exists rather than the inline stepper.
  previousQuantity: number;
  countedQuantity: number;
  // countedQuantity - previousQuantity, computed by the database as a generated
  // column so the record and the arithmetic cannot disagree. Negative is a
  // shortfall; positive means the app was wrong the other way.
  variance: number;
  reason: StockCountReason | null;
  // What a unit cost when it was counted, frozen. Null where the product is
  // uncosted -- null, never zero, because zero is a real answer (a free
  // sample). Frozen because valuing a count from six months ago must not use
  // whatever cost the most recent delivery happened to leave behind.
  unitCostCents: number | null;
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
  // Where this product's stock actually sits, per store. Populated by
  // `listProducts`; absent on the single-product reads that don't need it.
  // `stock` above stays the headline number — the shop-wide rollup, or this
  // store's count when the list was scoped — so existing readers are unaffected.
  locationStock?: { locationId: string; stock: number }[];
  createdAt: string;
  updatedAt: string;
};

export type NewProductInput = Omit<Product, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>;

export type Customer = {
  id: string;
  shopId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  neighborhood: string | null;
  tags: string[];
  notes: string | null;
  // Loyalty points on hand. A stored counter, not a sum computed here: it's
  // maintained by trigger from `customer_points_ledger` so a redemption has a
  // row to lock against a second register — see migration 20260820000000.
  //
  // Never negative; a clawback that can't be met is clamped and the shop
  // absorbs the rest. NOT the spendable figure either — points earned inside
  // the shop's maturing window are counted here but can't yet be redeemed, for
  // which see `customerPointsAvailable` in lib/customers.ts.
  pointsBalance: number;
  createdAt: string;
  updatedAt: string;
};

export type NewCustomerInput = Omit<Customer, 'id' | 'shopId' | 'pointsBalance' | 'createdAt' | 'updatedAt'>;

// One movement in a customer's points balance. Append-only: a correction is
// another row, never an edit, which is what lets the detail pane answer "why is
// my balance 148" with the actual history.
export type CustomerPointsEntry = {
  id: string;
  // Null once the sale it came from has been deleted — delete_sale posts
  // reversing rows before that happens, so the balance stays right regardless.
  saleId: string | null;
  deltaPoints: number;
  reason: 'earn' | 'redeem' | 'refund_clawback' | 'redeem_reversed' | 'adjustment';
  note: string | null;
  createdAt: string;
};

// One line item from a past sale attached to this customer -- powers the
// Customer detail pane's itemized purchase history (src/lib/customers.ts's
// listCustomerPurchases). Distinct from getCustomerStats, which is only
// the 3 aggregate numbers (total/visits/last purchase).
export type CustomerPurchase = {
  saleId: string;
  saleItemId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  paymentMethod: string;
  // Which store the sale was rung up at. Always set — `sales.location_id` is
  // NOT NULL (migration 20260809000000).
  locationId: string;
  createdAt: string;
};

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
  // Which store this belongs to. NULL = business-wide — head-office costs,
  // group marketing, a licence covering every store. A real value, not a gap:
  // per-store reporting excludes it, business-wide reporting includes it
  // (migration 20260816000000).
  locationId: string | null;
  name: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  scope: 'store' | 'brand' | 'category';
  // The brand or category name for those two scopes; null for 'store'.
  scopeValue: string | null;
  active: boolean;
  // The window the offer runs in. Null start = already running; null end =
  // until someone switches it off. These are SCHEDULING, and `active` is the
  // hard "off now" override on top of them — a promotion applies only when it
  // is active AND inside its window. See src/lib/discounts.ts.
  startsAt: string | null;
  endsAt: string | null;
  // False means the offer never fires by itself and only reaches a sale when
  // a cashier picks it. Campaign codes, staff discount, a goodwill gesture.
  autoApply: boolean;
  // A third state, distinct from the other two: `active = false` is paused and
  // may come back, an `endsAt` in the past is "this run is over", and this is
  // "gone from every list, kept only so old sales still read". Set instead of
  // deleting once a promotion has been applied to a sale.
  archivedAt: string | null;
  createdAt: string;
};

// Lives here rather than in lib/customer-segments.ts because AudienceFilter
// (below) needs it too, and lib/customer-segments.ts already imports
// `Customer` from this file — defining it there and importing it back here
// would make the dependency between models.ts and lib/ two-way.
export type CustomerSegment = 'vip' | 'at-risk' | 'new' | 'regular';

// Who a campaign is for, stored on `Campaign.audience` as jsonb. Lives here
// for the same reason as `CustomerSegment` above: lib/campaign-audience.ts
// already imports `Customer` from this file, so putting the type there and
// importing it back would make models.ts depend on lib/ while lib/ depends
// on models.ts — see src/lib/campaign-audience.ts for the field-by-field
// matching rules.
//
// A FILTER, not a list of ids: a customer whose phone number is corrected
// next week should join the queue on their own, without anyone rebuilding
// the campaign. Freezing the list at creation would make "fix a number and
// they get the message" impossible to honour.
//
// Every field is additive and an empty one means "no opinion": the default
// filter matches the whole directory.
export type AudienceFilter = {
  segments: CustomerSegment[];
  tags: string[];
  // "Has not bought in N days". Null means no opinion about purchase history.
  inactiveDays: number | null;
  // Reserved for a shop with several branches. Null means every branch.
  locationId: string | null;
};

// One offer, one audience, one message — see
// docs/superpowers/specs/2026-08-12-marketing-and-offers-design.md Phase 3.
export type Campaign = {
  id: string;
  shopId: string;
  // Null means a message with no discount behind it: new stock, a change of
  // hours, a thank you.
  promotionId: string | null;
  name: string;
  // Two drafts of the SAME message, not two campaigns — they share an
  // audience and a queue.
  messageEn: string | null;
  messageSo: string | null;
  audience: AudienceFilter;
  status: 'draft' | 'sending' | 'done';
  createdAt: string;
  startedAt: string | null;
};

// Deliberately weaker than it could be. WhatsApp reports nothing back to a
// deep-linking app, so 'sent' here means the OWNER said it sent when the app
// came back — not that WhatsApp confirmed anything. There is no 'delivered'
// and no 'read' on this path, and adding one would be a claim the app cannot
// support.
export type RecipientState = 'waiting' | 'opened' | 'sent' | 'skipped' | 'unreachable';

export type CampaignRecipient = {
  id: string;
  campaignId: string;
  customerId: string;
  state: RecipientState;
  openedAt: string | null;
  sentAt: string | null;
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
  // What the product cost the shop, frozen at sale time (same treatment as
  // `unitPriceCents` and `Sale.taxCents`) so COGS and past profit figures
  // don't move when a product's cost is later edited. Null for sales
  // predating the snapshot column, or products with no cost recorded —
  // reported as "uncosted" rather than counted as zero.
  unitCostCents: number | null;
  // Which offer produced `discountCents` on this line, if any — see
  // migration 20260826000100_sale_promotion_attribution. `promotionName` is
  // frozen at the time this line was written (renaming/archiving/deleting the
  // promotion later doesn't change past sales, same treatment as
  // `productName`); `promotionId` is null for a manually-typed discount and
  // for any line predating the migration.
  promotionId: string | null;
  promotionName: string | null;
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
  // Money taken against this sale AFTER it was rung up, at whatever till was
  // open (migration 20260831000100). The sale editor has to exclude these when
  // it seeds itself: it re-sends what it is given, and edit_sale preserves
  // settlements independently, so including them counts the same money twice.
  isSettlement: boolean;
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
    paymentMethod: SalePaymentMethod;
    customerName: string | null;
    customerPhone: string | null;
    customerEmail: string | null;
    discountCents: number;
    items: SaleItemSnapshot[];
    payments: PaymentLine[];
  };
};

export type RefundItem = {
  id: string;
  refundId: string;
  saleItemId: string;
  productId: string | null;
  quantity: number;
  amountCents: number;
};

// A single refund event against a sale, possibly covering several of its
// items at once (see refund_sale_items) -- a sale can have many of these
// over time as it's partially refunded across separate visits.
export type Refund = {
  id: string;
  saleId: string;
  refundedBy: string | null;
  // Cash handed back, capped at what was collected. `goodsCents` is the value
  // returned, which is what cancels the debt and the revenue -- the two differ
  // only on a sale taken on credit (migration 20260831000200).
  totalCents: number;
  goodsCents: number;
  createdAt: string;
  items: RefundItem[];
};

export type Sale = {
  id: string;
  shopId: string;
  // Which branch rang this sale up. Not null in the database (migration
  // 20260809000000 backfilled every pre-existing sale to its shop's primary
  // location), so per-location reporting can never have an unattributed row.
  locationId: string;
  createdBy: string | null;
  paymentMethod: SalePaymentMethod;
  paymentNote: string | null;
  // Who the sale was for, independent of payment method — unlike
  // `SalePayment.customerName/customerPhone` (only meaningful for
  // ZAAD/e-Dahab payment lines), this applies to any sale regardless of how
  // it was paid, including cash.
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  // The linked customer record, if this sale was attached to one at
  // checkout/edit time -- independent of the frozen name/phone/email
  // snapshot above, which never changes even if the customer record does.
  customerId: string | null;
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
  // Loyalty movement for this sale, frozen at the till like the tax rate above.
  // `pointsRedeemedCents` is the money the redemption took off, kept apart from
  // `discountCents` so a receipt can print the two as the different things they
  // are. `loyaltyPointsPerUsd` is the earn rate that produced `pointsEarned`,
  // null when the sale earned nothing.
  pointsEarned: number;
  pointsRedeemed: number;
  pointsRedeemedCents: number;
  loyaltyPointsPerUsd: number | null;
  totalCents: number;
  itemCount: number;
  createdAt: string;
  items?: SaleItem[];
  payments?: SalePayment[];
  // When the last of this sale's money arrived; null while any of it is still
  // owed (migration 20260831000000). Undefined on a caller that did not select
  // it, which reads the same as settled -- the safe direction, because the only
  // thing that consumes it is whether to print a BALANCE DUE line.
  settledAt?: string | null;
  edits?: SaleEdit[];
  refunds?: Refund[];
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

// Who the shop buys from and pays — suppliers, the landlord, an ad agency.
// Managed in Settings → Store, and quick-addable inline while recording an
// expense. Distinct from `Product.supplierName`, which is a free-text note on
// a single product rather than a payee the shop has a relationship with.
export type Vendor = {
  id: string;
  shopId: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewVendorInput = Omit<Vendor, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>;

export type ExpenseCategory =
  | 'inventory_purchase'
  | 'stock_loss'
  | 'rent'
  | 'utilities'
  | 'salaries_wages'
  | 'marketing'
  | 'supplies'
  | 'transport_delivery'
  | 'maintenance_repairs'
  | 'fees_charges'
  | 'owner_draw'
  | 'other';

export type Expense = {
  id: string;
  shopId: string;
  // Which store this belongs to. NULL = business-wide — head-office costs,
  // group marketing, a licence covering every store. A real value, not a gap:
  // per-store reporting excludes it, business-wide reporting includes it
  // (migration 20260816000000).
  locationId: string | null;
  // When the money was actually spent, which is what decides the reporting
  // period — distinct from `createdAt`, when the receipt got typed in.
  occurredOn: string;
  amountCents: number;
  category: ExpenseCategory;
  vendorId: string | null;
  // Joined from `vendors` for display, not stored on the row.
  vendorName: string | null;
  paymentMethod: PaymentMethod;
  note: string | null;
  // Set when this row was generated rather than entered by hand — by a vendor
  // bill, or by posting a pay run. Both are read-only at the database level
  // (the bill or the run is the record of truth), so the UI must not offer an
  // edit that RLS will refuse.
  invoiceId: string | null;
  payrollRunId: string | null;
  // Which delivery or which stock-take this row belongs to, when it was written
  // by the Restock or Count sheet's "also log this" tick rather than typed on
  // the Expenses screen (migration 20260908000800). These decide WHAT THE ROW
  // POSTS, and the difference is not cosmetic:
  //
  //   * `stockReceiptId` — the delivery was already recorded as Dr 1200
  //     Inventory / Cr 2000 Accounts Payable, so this row is the money going
  //     out: Dr 2000 / Cr the wallet. A standalone `inventory_purchase` with no
  //     receipt behind it still debits 1200, because nothing else did.
  //   * `stockCountId` — `save_stock_count` already posted both sides of the
  //     write-off and no money moved, so this row posts nothing at all. A
  //     standalone `stock_loss` posts Dr 5100 / Cr 1200.
  //
  // At most one of the four link columns is ever set (a CHECK enforces it).
  stockReceiptId: string | null;
  stockCountId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

// The two stock links are OPTIONAL rather than required, unlike every other
// field here. Almost every caller is the expense editor, which has no receipt
// and no count to point at, and making them mandatory would force a pair of
// `null`s onto every call site to describe the ordinary case.
export type NewExpenseInput = Omit<
  Expense,
  | 'id'
  | 'shopId'
  | 'vendorName'
  | 'createdBy'
  | 'createdAt'
  | 'updatedAt'
  | 'invoiceId'
  | 'payrollRunId'
  | 'stockReceiptId'
  | 'stockCountId'
> & {
  stockReceiptId?: string | null;
  stockCountId?: string | null;
};

// A bill the shop owes a vendor — accounts payable, not customer invoicing.
// Recording one posts a linked `Expense` (see the invoices migration), so the
// cost hits the P&L when incurred; payments against it only settle the debt.
export type Invoice = {
  id: string;
  shopId: string;
  // Which store this belongs to. NULL = business-wide — head-office costs,
  // group marketing, a licence covering every store. A real value, not a gap:
  // per-store reporting excludes it, business-wide reporting includes it
  // (migration 20260816000000).
  locationId: string | null;
  vendorId: string | null;
  // Frozen at creation, like Sale's customer fields — the record of who a bill
  // was owed to has to survive the vendor being renamed or removed.
  vendorName: string | null;
  vendorPhone: string | null;
  // The supplier's own reference, as printed on their paperwork.
  invoiceNumber: string;
  category: ExpenseCategory;
  description: string | null;
  issuedOn: string;
  dueOn: string;
  amountCents: number;
  paidCents: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  payments?: InvoicePayment[];
};

export type InvoicePayment = {
  id: string;
  invoiceId: string;
  amountCents: number;
  paidOn: string;
  method: PaymentMethod;
  note: string | null;
  createdAt: string;
};

export type NewInvoiceInput = Omit<
  Invoice,
  'id' | 'shopId' | 'paidCents' | 'createdBy' | 'createdAt' | 'updatedAt' | 'payments' | 'vendorName' | 'vendorPhone'
> & { vendorName: string | null; vendorPhone: string | null };

// Where the shop's money physically sits. A manually-confirmed snapshot, not
// a computed ledger — see the cash-and-budgets migration for why.
export type CashAccount = {
  id: string;
  shopId: string;
  // Which store this drawer or account belongs to. Always set: a till sits on a
  // counter, and two stores each counting their own is the point (migration
  // 20260815000000).
  locationId: string;
  name: string;
  accountType: 'cash' | 'bank' | 'mobile_money' | 'other';
  // May be negative: a bank account can be overdrawn.
  balanceCents: number;
  notes: string | null;
  balanceAsOf: string;
  createdAt: string;
  updatedAt: string;
};

export type NewCashAccountInput = Omit<CashAccount, 'id' | 'shopId' | 'balanceAsOf' | 'createdAt' | 'updatedAt'>;

// A cost that repeats on a schedule. A template only — nothing reaches the
// P&L until it's logged, which posts a real Expense and advances the due date.
export type RecurringBill = {
  id: string;
  shopId: string;
  // Which store this belongs to. NULL = business-wide — head-office costs,
  // group marketing, a licence covering every store. A real value, not a gap:
  // per-store reporting excludes it, business-wide reporting includes it
  // (migration 20260816000000).
  locationId: string | null;
  name: string;
  category: ExpenseCategory;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
  amountCents: number;
  paymentMethod: PaymentMethod;
  nextDueDate: string;
  vendorId: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewRecurringBillInput = Omit<RecurringBill, 'id' | 'shopId' | 'createdAt' | 'updatedAt'>;

export type Budget = {
  id: string;
  shopId: string;
  // Which store this belongs to. NULL = business-wide — head-office costs,
  // group marketing, a licence covering every store. A real value, not a gap:
  // per-store reporting excludes it, business-wide reporting includes it
  // (migration 20260816000000).
  locationId: string | null;
  category: ExpenseCategory;
  limitCents: number;
  createdAt: string;
  updatedAt: string;
};

// A pay period being prepared or already paid. Posting a run writes one
// `salaries_wages` expense, which is how wages reach the P&L.
export type PayrollRun = {
  id: string;
  shopId: string;
  // Which store this belongs to. NULL = business-wide — head-office costs,
  // group marketing, a licence covering every store. A real value, not a gap:
  // per-store reporting excludes it, business-wide reporting includes it
  // (migration 20260816000000).
  locationId: string | null;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'posted';
  // Which cadence this run was built for; null for an off-cycle run over
  // hand-typed dates, which includes every active member.
  cadence: PayCadence | null;
  totalCents: number;
  // The expense this run generated; null while still a draft.
  expenseId: string | null;
  postedAt: string | null;
  postedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: PayrollRunLine[];
};

export type PayrollRunLine = {
  id: string;
  payrollRunId: string;
  shopMemberId: string;
  // Name, type and rate are frozen when the draft is built, so a later pay
  // rise doesn't restate what a past run paid.
  memberName: string | null;
  payType: StaffMember['payType'];
  payRateCents: number | null;
  hoursWorked: number | null;
  // Computed to begin with, then editable until the run is posted.
  amountCents: number;
  note: string | null;
  // Frozen at draft time alongside pay_type/pay_rate_cents. Never recomputed:
  // a later pay-rate change must not restate what a past run warned about.
  warning: string | null;
  warningBlocking: boolean;
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
  // Which store this happened at. Always set (migration 20260815000000) — a
  // shift, a clock-in or a till without a store is a gap in the data, never a
  // legitimate state.
  locationId: string;
  name: string;
  createdAt: string;
};

// A durable named place a sale is rung from — usually a counter with a drawer,
// sometimes a person's phone. Deliberately NOT ephemeral: `id` outlives every
// session opened on it, which is what makes "is Register 2 short three days
// running" answerable at all. See migration 20260822000000.
//
// Distinct from `Cashier`, which is only a label printed on a receipt.
export type Register = {
  id: string;
  shopId: string;
  // NOT NULL for phones too. A mobile seller still sells somewhere, and stock,
  // takings and staff access are all branch-scoped.
  locationId: string;
  name: string;
  // Free-text context: where it stands, what a cashier should know about it.
  // Distinct from `name`, which is identity and renders in the POS bar and
  // every session row — see migration 20260822000500 for why they are split.
  note: string | null;
  kind: 'counter' | 'mobile';
  // Whose phone, for kind='mobile'. Null for a counter — a till belongs to the
  // shop, not to whoever is standing at it.
  shopMemberId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

// One currency's worth of the drawer, at both ends of a session. A Hargeisa
// drawer holds USD and SLSH at once, so a session has one of these per
// currency rather than a single float.
//
// Every `*Minor` figure is in that currency's minor unit — the same convention
// `sale_payments.foreign_amount_cents` uses, and the same as USD cents.
export type RegisterSessionCash = {
  id: string;
  sessionId: string;
  // 'USD' for the base currency. Written out rather than left null (as
  // `sale_payments.currency_code` does) because Postgres unique indexes treat
  // nulls as distinct, which would allow several base rows per session.
  currencyCode: string;
  openingFloatMinor: number;
  // Snapshotted at both ends, so reopening last Tuesday's close next month
  // cannot re-convert it at today's rate and quietly change a signed-off
  // figure. The drift between the two is the day's FX exposure on the float —
  // real money, but not a cash discrepancy.
  openingRateToUsd: number;
  closingCountedMinor: number | null;
  closingRateToUsd: number | null;
  expectedMinor: number | null;
  varianceMinor: number | null;
  // Counts keyed by note VALUE in minor units, plus an `other` key carrying a
  // plain amount: {"10000": 2, "5000": 3, "other": 350}. Never a foreign key
  // into the shop's denomination list, so a note that list doesn't know about
  // is simply another key.
  openingDenominations: Record<string, number> | null;
  closingDenominations: Record<string, number> | null;
};

// One open→close cycle on a register: who was on it, what they started with,
// what they handed over, and whether it added up.
export type RegisterSession = {
  id: string;
  shopId: string;
  locationId: string;
  registerId: string;
  // Null for an owner-run session: this app gives an owner no shop_members row
  // (adminship is shops.owner_id), so `openedBy` carries who it was instead.
  // Every session names a person one way or the other — see 20260822000200.
  shopMemberId: string | null;
  openedBy: string | null;
  openedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  // Sum of the per-currency variances, each converted at its own CLOSING rate.
  // Frozen at close. Null while the session is open.
  varianceBaseCents: number | null;
  openingNote: string | null;
  closingNote: string | null;
  // The session this one took over from. Set only by a handover — a register
  // opened fresh a minute after a close is a NEW run, not a continuation, and
  // inferring the link from timestamps could not tell the two apart.
  handedOverFrom: string | null;
  cash: RegisterSessionCash[];
};

// One sale rung through a session, for the detail sheet's transaction list.
export type SessionTransaction = {
  id: string;
  createdAt: string;
  totalCents: number;
  itemCount: number;
  customerName: string | null;
  payments: PaymentLine[];
  // Refunds are listed alongside sales, in the order things happened: a refund
  // takes cash out of whichever drawer was open when it was issued, so hiding
  // it from that session's list would hide it from the person holding the cash.
  kind: 'sale' | 'refund';
};

// What the client sends for one currency when opening or closing. `amountMinor`
// is what was counted; `rateToUsd` defaults server-side from `shop_currencies`
// when omitted, and is editable at the counter because the street rate moves
// faster than Settings does.
export type DrawerCountEntry = {
  currencyCode: string;
  amountMinor: number;
  rateToUsd: number | null;
  denominations: Record<string, number> | null;
};

export type Role = {
  id: string;
  shopId: string;
  name: string;
  permissions: string[];
  createdAt: string;
};

export type StaffMember = {
  id: string;
  shopId: string;
  userId: string;
  roleId: string;
  roleName: string;
  // Which stores this person works at. An EMPTY array means every store — a
  // person can cover two of three, so this is a set, not a single choice
  // (migration 20260814000000). Access is (stores, role): the role says what
  // they may do, this says where. Enforced by can_access_location() in the
  // database, not only in the UI.
  //
  // Ids only, no names: the client already holds the store list and joins by
  // id, which is what keeps a rename from leaving stale names behind.
  locationIds: string[];
  active: boolean;
  fullName: string | null;
  email: string | null;
  // Free text, like customers.phone — normalized only when a wa.me link is
  // built (see whatsappLink). Optional: a staff login needs an email, not a
  // phone.
  phone: string | null;
  // Optional. Falls back to initials on the roster; a shop that never uploads
  // one is not incomplete.
  photoUrl: string | null;
  createdAt: string;
  hireDate: string | null;
  payType: 'hourly' | 'salary' | 'fixed' | null;
  payRateCents: number | null;
  // How often they're paid, independent of what they're paid. Applies to
  // hourly staff too.
  payCadence: PayCadence;
};

export type TimeEntry = {
  id: string;
  shopId: string;
  // Which store this happened at. Always set (migration 20260815000000) — a
  // shift, a clock-in or a till without a store is a gap in the data, never a
  // legitimate state.
  locationId: string;
  shopMemberId: string;
  clockIn: string;
  clockOut: string | null;
  createdAt: string;
};

export type TimeOffRequest = {
  id: string;
  shopId: string;
  shopMemberId: string;
  startDate: string; // Earliest date in dateRanges (for compatibility)
  endDate: string; // Latest date in dateRanges (for compatibility)
  dateRanges: {startDate: string; endDate: string}[]; // Multiple non-contiguous ranges
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'cost_of_sales' | 'expense';

export type Account = {
  id: string;
  shopId: string;
  code: string;
  name: string;
  type: AccountType;
  isContra: boolean;
  archivedAt: string | null;
};

export type JournalEntryStatus = 'draft' | 'posted' | 'reversed';

export type JournalEntry = {
  id: string;
  shopId: string;
  entryDate: string;
  reference: string | null;
  description: string;
  source: string;
  status: JournalEntryStatus;
  locationId: string | null;
  reversesEntryId: string | null;
  createdAt: string;
  lines: JournalLine[];
};

// amountCents is SIGNED: debit positive, credit negative. The two columns a
// reader expects are a projection of this one number -- see debitOf/creditOf in
// src/lib/ledger-math.ts. Never add a separate debit and credit field; a shape
// that can hold both is a shape that will eventually hold both.
export type JournalLine = {
  id: string;
  accountId: string;
  amountCents: number;
  locationId: string | null;
  memo: string | null;
};

export type PublicStorefront = {
  shopName: string;
  city: string | null;
  slug: string;
  whatsappE164: string | null;
  theme: string;
  palette: string;
  headline: string | null;
  about: string | null;
  heroImageUrl: string | null;
  offersDelivery: boolean;
  paymentMode: 'on_collection';
};

export type StorefrontProduct = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  priceCents: number;
  stock: number;
  imageUrl: string | null;
};

// get_public_delivery_areas' shape -- no id, no sort_order, because the
// function already returns them pre-sorted (order by a.sort_order, a.name)
// and a checkout form has no use for an area's id, only its name (the value
// place_storefront_order matches against) and its fee.
export type PublicDeliveryArea = {
  name: string;
  feeCents: number;
};
