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
  categories: string[];
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

export type CartLine = { product: Product; quantity: number };

export type SaleItem = {
  id: string;
  saleId: string;
  productId: string | null;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
};

// One line of a (possibly split) checkout payment. `tenderedCents` is only
// meaningful for cash (what the customer physically handed over, so change
// due = tenderedCents - amountCents); `customerName`/`customerPhone` are
// only meaningful for mobile-money methods like ZAAD/e-Dahab.
export type PaymentLine = {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents: number | null;
  customerName: string | null;
  customerPhone: string | null;
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
  createdAt: string;
};

export type Tag = {
  id: string;
  shopId: string;
  name: string;
  createdAt: string;
};
