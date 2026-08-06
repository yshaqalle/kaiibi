import { customerDisplayName, searchCustomers } from '@/lib/customers';
import { searchExpenses } from '@/lib/expenses';
import { searchInvoices } from '@/lib/invoices';
import type { Permission } from '@/lib/permissions';
import { searchProducts } from '@/lib/products';
import { searchSales } from '@/lib/sales';
import { listStaff } from '@/lib/staff';
import { formatAccountingCents } from '@/lib/currency';
import { expenseCategoryLabel } from '@/lib/expense-reporting';

// Cross-entity search for the Dashboard's header field.
//
// One fan-out over the per-entity searches that live beside their own row
// mappers (searchProducts in products.ts, searchInvoices in invoices.ts, and
// so on), turned into one ranked, typed list. Nothing here talks to Supabase
// directly -- this module decides WHAT may be searched and HOW results are
// ordered, and the libs decide how each table is queried.
//
// Two rules it exists to enforce:
//
// 1. Permission gating per entity type. A cashier must never see invoice or
//    expense hits. RLS is the real enforcement -- these queries would be
//    refused server-side -- but a UI that offers a result the database will
//    deny is a UI that looks broken, so the client gates too. Same two-layer
//    rule as lib/permissions.ts.
//
// 2. One refused entity must not blank the whole result set. Each branch
//    settles independently; a bills query failing costs bills, not the search.

export type SearchResultKind = 'product' | 'customer' | 'staff' | 'sale' | 'invoice' | 'expense';

export type SearchResult = {
  kind: SearchResultKind;
  id: string;
  title: string;
  /** Secondary line — SKU, phone, due date, amount. */
  subtitle?: string;
  /** Sorted ascending; lower sorts first. */
  rank: number;
};

export type SearchAbility = { can: (permission: Permission) => boolean };

// Which kinds outrank which, when scores tie. A product is what a shopkeeper
// looks up most, so it leads; an expense is the most incidental, so it trails.
const KIND_ORDER: Record<SearchResultKind, number> = {
  product: 0,
  customer: 1,
  sale: 2,
  invoice: 3,
  staff: 4,
  expense: 5,
};

// A hit whose name STARTS with the query is what the reader meant far more
// often than one that merely contains it -- "sug" should surface "Sugar 2kg"
// above "Brown sugar sachets". Ranking happens here rather than in SQL because
// the comparison is across entity types, which no single query can see.
function score(kind: SearchResultKind, title: string, query: string): number {
  const haystack = title.toLowerCase();
  const needle = query.trim().toLowerCase();
  const position = haystack.indexOf(needle);
  const proximity = position < 0 ? 3 : position === 0 ? 0 : 1;
  return KIND_ORDER[kind] + proximity * 10;
}

export async function searchEverything(
  shopId: string,
  query: string,
  ability: SearchAbility,
  locationId?: string | null
): Promise<SearchResult[]> {
  const q = query.trim();
  // Two characters is the floor every underlying search already enforces;
  // checking here as well saves six round trips on a single keystroke.
  if (q.length < 2) return [];

  const { can } = ability;

  const tasks: Promise<SearchResult[]>[] = [];

  if (can('inventory.view')) {
    tasks.push(
      searchProducts(shopId, q).then((rows) =>
        rows.map((product) => ({
          kind: 'product' as const,
          id: product.id,
          title: product.name,
          subtitle: [product.sku, `${product.stock} in stock`].filter(Boolean).join(' · '),
          rank: score('product', product.name, q),
        }))
      )
    );
  }

  if (can('customers.view')) {
    tasks.push(
      searchCustomers(shopId, q).then((rows) =>
        rows.map((customer) => {
          const title = customerDisplayName(customer);
          return {
            kind: 'customer' as const,
            id: customer.id,
            title,
            subtitle: customer.phone ?? undefined,
            rank: score('customer', title, q),
          };
        })
      )
    );
  }

  if (can('sales.view')) {
    tasks.push(
      searchSales(shopId, q, locationId).then((rows) =>
        rows.map((sale) => ({
          kind: 'sale' as const,
          id: sale.id,
          title: sale.customerName || 'Walk-in sale',
          subtitle: `${new Date(sale.createdAt).toLocaleDateString()} · ${formatAccountingCents(sale.totalCents)}`,
          // `||`, matching `title` above: a sale with an empty-string name is
          // scored on the fallback it actually displays, not on ''.
          rank: score('sale', sale.customerName || 'Walk-in sale', q),
        }))
      )
    );
  }

  if (can('invoices.view')) {
    tasks.push(
      searchInvoices(shopId, q).then((rows) =>
        rows.map((invoice) => {
          // A bill can be raised without naming the vendor; falling back to
          // its number keeps the row identifiable rather than blank.
          const title = invoice.vendorName || invoice.invoiceNumber || 'Bill';
          return {
            kind: 'invoice' as const,
            id: invoice.id,
            title,
            subtitle: [invoice.invoiceNumber, `due ${invoice.dueOn}`, formatAccountingCents(invoice.amountCents - invoice.paidCents)]
              .filter(Boolean)
              .join(' · '),
            rank: score('invoice', title, q),
          };
        })
      )
    );
  }

  if (can('expenses.view')) {
    tasks.push(
      searchExpenses(shopId, q).then((rows) =>
        rows.map((expense) => ({
          kind: 'expense' as const,
          id: expense.id,
          title: expense.note || expenseCategoryLabel(expense.category),
          subtitle: `${expense.occurredOn} · ${formatAccountingCents(expense.amountCents)}`,
          // `||`, matching `title` above -- an empty note falls through to the
          // category for both, so the row is ranked on what it shows.
          rank: score('expense', expense.note || expenseCategoryLabel(expense.category), q),
        }))
      )
    );
  }

  if (can('people.timesheet.view') || can('staff.manage')) {
    // Filtered client-side, unlike every other branch. `list_shop_staff` is an
    // RPC with no query parameter, so a server-side name search would need a
    // migration -- and a shop has tens of staff, not thousands, so the whole
    // roster is a cheap fetch. Revisit if the roster ever grows.
    tasks.push(
      listStaff(shopId).then((rows) =>
        rows
          .filter((member) => (member.fullName ?? '').toLowerCase().includes(q.toLowerCase()))
          .slice(0, 5)
          .map((member) => {
            // Provisioned-but-not-yet-signed-up staff have no name on the row.
            const title = member.fullName || member.email || 'Team member';
            return {
              kind: 'staff' as const,
              id: member.id,
              title,
              subtitle: [member.roleName, member.active ? undefined : 'inactive'].filter(Boolean).join(' · '),
              rank: score('staff', title, q),
            };
          })
      )
    );
  }

  const settled = await Promise.allSettled(tasks);
  const results = settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
  return results.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}
