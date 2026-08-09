# Module map

Scope keywords, what each one owns, and the flow that proves it works. A module
test walks every flow in its row; a functionality test walks only the flow the
diff touched.

## Modules

| Scope | Route | Owns | Core flows |
|---|---|---|---|
| `pos` | `/pos` | `(tabs)/pos.tsx`, `components/pos/*`, `checkout-panel`, `receipt-modal`, `refund-modal`, `discount-editor`, `payment-method-picker`, `quantity-stepper`, `customer-picker`, `scan-*` | Add to cart → checkout → tender → complete → receipt. Line + order discount. Refund. Scan to cart. Sell to a named customer. |
| `inventory` | `/inventory`, `/product/[id]`, `/product/new` | `(tabs)/inventory.tsx`, `product-form`, `product-modal`, `product-table-row`, `product-tile`, `csv-import-modal`, `category-chip`, `lib/products*` | Add product. Edit price/stock. Stepper adjust. Low-stock + no-cost filters. CSV import/export. Barcode assign. |
| `people` | `/people` | `(tabs)/people.tsx`, `customer-*`, `staff-self-service`, `components/schedule/*`, `edit-pay-modal`, `pay-fields`, `lib/{customers,staff,scheduling,shifts}` | Customers / Team / Schedule tabs. Add customer. Add staff + pay rate. Create shift. Loyalty balance. |
| `accounting` | `/accounting` | `components/accounting/*`, `lib/{pnl,expenses,invoices,payroll,cash-budgets,sales-reporting}` | Overview, Transactions, Expenses, Invoices, Payroll, Cash budgets, Reports tabs. Log expense. Raise + pay invoice. Run payroll. Export PDF/CSV. |
| `dashboard` | `/dashboard` | `components/dashboard/*`, `attention-list`, `global-search`, `range-selector` | Takings hero, overview cards, best sellers, leaderboard, open hours. Range switch. Global search. Tasks list. |
| `registers` | `/pos` + `/accounting` | `register-bar`, `open-register-sheet`, `close-register-sheet`, `drawer-count`, `register-session-detail`, `register-sessions-card`, `lib/{registers,register-sessions}` | Open with float → sell → handover → close with count → session detail + variance + notes. |
| `settings` | `/settings` | `components/settings/panels/*` — business, catalog, locations, registers, roles, sales, receipt, notifications, vendors, security, billing, profile | Open each panel, change one value, confirm it persists and shows where it is consumed. |
| `platform` | `/platform` | `app/platform/*`, `platform-overview`, `platform-charts`, `lib/platform` | Platform-admin portal loads, shop list, plan change requests. |
| `public` | `/`, `/login`, `/signup`, `/about`, `/privacy/policy` | `app/(public)/*`, `components/landing/*` | Landing renders, language switch EN/SO, signup validation, login, logged-out redirects. |

## Cross-module assertions

These are the ones that actually catch regressions — a module passing in
isolation while the money stops adding up is the failure worth finding.

- **A POS sale** decrements product stock, adds a row to accounting
  transactions, raises the register's "N sales · $X taken" tally, moves
  dashboard takings, and — if a customer was attached — moves their loyalty
  balance and lifetime spend.
- **A product with no purchase cost** understates stock-at-cost and overstates
  gross profit; inventory shows a caveat and accounting's profit figure must
  agree with it.
- **Closing a register** with a counted drawer produces a variance against
  expected cash, and the session appears in accounting's register sessions.
- **A refund** reverses takings and returns stock.
- **Tax** (2.5% on this shop) means takings exceed revenue; dashboard says so
  explicitly. Revenue net of tax is the profit input, not gross takings.

## Mapping a diff to scopes

```bash
git diff --name-only main...HEAD    # or: git diff --name-only  for uncommitted
```

- `src/app/(admin)/(tabs)/<name>.tsx` or `src/components/<name>/**` → that module.
- `src/lib/<name>.ts` → every module in the table whose "Owns" column lists it.
- `src/components/{card,bento,data-table,screen-header,segmented-control,badge,
  date-input,option-picker,export-menu}*`, `src/constants/**`, `src/app/_layout.tsx`,
  `app-tabs*`, `admin-*` → **cross-cutting**: every module that renders it.
- `*.web.tsx` → web only. `ios/**` → iPhone + iPad. `android/**` → both Android.
- `useWindowDimensions`, `compact`, `desktop`, or any breakpoint edit → all four
  platforms, because that is precisely the code that only breaks at one width.
- `supabase/migrations/**` → the owning module plus `accounting` (most tables
  feed a report).

**Cross-cutting means module-level tests on top of the functionality test.** A
shared component changed under five screens is not tested by exercising one of
them.