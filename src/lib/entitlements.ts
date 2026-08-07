// The fixed catalog of billable capabilities — the entitlement counterpart to
// src/lib/permissions.ts. Keep the two straight:
//
//   a Permission  answers "may this USER do X"  and is set by the shop's admin
//   a Module      answers "has this SHOP paid for X" and is set by us
//
// They are orthogonal and both must pass. A cashier holding inventory.edit at a
// shop whose trial lapsed still cannot add a product.
//
// Enforced in two places, and both are required: the DB (migration
// 20260818000400's module gates on every write policy, plus the limit triggers
// in 20260818000300, which is what actually stops a request made straight
// against the API with the anon key) and the client (the route guard in
// app/(admin)/_layout.tsx plus the nav/action gates, so the UI never offers
// something the DB will refuse).
//
// Like PERMISSIONS this catalog lives in code rather than a table: plans store
// `modules text[]` and unknown entries are dropped on read, so a plan row can
// outlive a catalog change.
export type Module =
  | 'pos'
  | 'inventory'
  | 'customers'
  | 'dashboard'
  | 'accounting'
  | 'payroll'
  | 'budgets'
  | 'promotions'
  | 'scheduling'
  | 'multi_location'
  | 'multi_currency'
  | 'data_export'
  | 'receipt_branding_removal';

export const MODULES: { key: Module; label: string; description: string }[] = [
  { key: 'pos', label: 'Point of sale', description: 'Ring up sales and take payment at the register.' },
  { key: 'inventory', label: 'Inventory', description: 'Keep a product list and track stock.' },
  { key: 'customers', label: 'Customers', description: 'Build a customer directory and see who buys what.' },
  { key: 'dashboard', label: 'Dashboard', description: 'Revenue, trends, and shop analytics.' },
  { key: 'accounting', label: 'Accounting', description: 'Expenses, vendor bills, and cash on hand.' },
  { key: 'payroll', label: 'Payroll', description: 'Run pay periods and post wages to the books.' },
  { key: 'budgets', label: 'Budgets', description: 'Set category budgets and track recurring bills.' },
  { key: 'promotions', label: 'Promotions', description: 'Automatic discounts across the store or a category.' },
  { key: 'scheduling', label: 'Team schedule', description: "Plan who works when, ahead of time." },
  { key: 'multi_location', label: 'Multiple stores', description: 'Open more than one branch and move stock between them.' },
  { key: 'multi_currency', label: 'Multiple currencies', description: 'Take payment in more than one currency.' },
  { key: 'data_export', label: 'Data export', description: 'Export sales, stock, and reports to CSV or PDF.' },
  // The one module in this catalog that REMOVES something rather than
  // unlocking it. Receipts carry the Kaiibi mark by default, and a plan
  // granting this takes it off.
  //
  // Written that way round on purpose: 'default on' then has to be true of
  // every shop that has never been considered -- new shops, trials, lapsed
  // plans, and any plan an admin forgets to tick. The inverse ('branding'
  // as a granted module) would silently drop the mark from every one of
  // them, which is the failure we cannot see happening.
  {
    key: 'receipt_branding_removal',
    label: 'Remove Kaiibi branding',
    description: 'Print receipts without the "Powered by Kaiibi" footer.',
  },
];

export const ALL_MODULES: Module[] = MODULES.map((m) => m.key);

// Countable things a plan can cap. Kept as a union so a typo in a limit name is
// a compile error rather than a silently-unlimited resource -- the failure
// direction matters, since an unknown key resolves to "unlimited" by design
// (see shop_limit() in migration 20260818000200).
export type LimitResource =
  | 'locations'
  | 'products'
  | 'staff'
  | 'customers'
  | 'vendors'
  | 'sales_per_month';

export const LIMIT_RESOURCES: { key: LimitResource; label: string; noun: string }[] = [
  { key: 'locations', label: 'Stores', noun: 'store' },
  { key: 'products', label: 'Products', noun: 'product' },
  { key: 'staff', label: 'Team members', noun: 'team member' },
  { key: 'customers', label: 'Customers', noun: 'customer' },
  { key: 'vendors', label: 'Vendors', noun: 'vendor' },
  { key: 'sales_per_month', label: 'Sales this month', noun: 'sale' },
];

// 'suspended' is an operator action (fraud/abuse); everything else is derived
// from dates by shop_effective_status(). 'grace' is still fully usable -- it
// exists because payment here is mobile money confirmed by hand, so a shop that
// paid on Thursday must not be locked out on Friday because we hadn't recorded
// it yet.
export type SubscriptionStatus = 'trialing' | 'active' | 'grace' | 'expired' | 'suspended';

// What my_shop_entitlements() returns, mapped to camelCase.
export type Entitlements = {
  // False when the lookup did not succeed and this is the fail-closed default
  // rather than the shop's real state.
  //
  // It exists because failing closed is right for ENFORCEMENT and wrong for
  // WORDING. Without it a shop whose entitlement call merely failed -- an
  // outage, a stale build, a migration not yet applied -- is told "your plan
  // has ended", which is alarming and false. The restriction still applies
  // (the server is the authority and it will refuse writes anyway); only what
  // we say about it changes.
  resolved: boolean;
  status: SubscriptionStatus;
  planKey: string;
  planName: string;
  priceCents: number;
  currency: string;
  billingInterval: 'month' | 'year' | null;
  modules: Module[];
  // null value = unlimited. A resource missing from the map means the same.
  limits: Partial<Record<LimitResource, number | null>>;
  usage: Partial<Record<LimitResource, number>>;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
};

// What an unresolved entitlement set reads as. Deliberately the FREE tier and
// not the full catalog: the DB is authoritative, so a client that briefly
// over-restricts costs a retry, while one that over-permits shows buttons the
// server will refuse -- and, worse, is the shape a monetization bypass takes.
// Same fail-closed reasoning as `noPermissions` in hooks/use-auth.tsx.
export const FREE_FALLBACK: Entitlements = {
  resolved: false,
  status: 'expired',
  planKey: 'free',
  planName: 'Free',
  priceCents: 0,
  currency: 'USD',
  billingInterval: null,
  modules: ['pos', 'inventory'],
  limits: { locations: 1, products: 50, staff: 2, customers: 100, vendors: 0, sales_per_month: 300 },
  usage: {},
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceUntil: null,
};

// Drops unknown strings, the same way expandPermissions() does for a role row
// that predates a catalog change. There are no implications between modules --
// a plan lists exactly what it grants -- so this is only a filter.
export function expandModules(stored: readonly string[]): Module[] {
  const known = new Set(stored);
  return ALL_MODULES.filter((m) => known.has(m));
}

// Every route inside `(admin)` that needs a MODULE, on top of whatever
// Permission it already needs in permissions.ts. Same longest-prefix-first
// matching, and the same "not listed means unrestricted" rule.
//
// Note /people and /settings are absent: People holds self-service HR that any
// active member must reach whatever the shop pays, and locking a shop out of
// Settings would take away the Billing panel -- the one screen that tells them
// how to start paying again.
const ROUTE_MODULES: { prefix: string; module: Module }[] = [
  { prefix: '/dashboard', module: 'dashboard' },
  { prefix: '/pos', module: 'pos' },
  { prefix: '/inventory', module: 'inventory' },
  { prefix: '/product', module: 'inventory' },
  { prefix: '/accounting', module: 'accounting' },
];

export function moduleForPath(pathname: string): Module | null {
  const match = [...ROUTE_MODULES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`));
  return match?.module ?? null;
}

// null/undefined limit = unlimited, so this is false. Note `>=`: called BEFORE
// creating a record, so being AT the cap already means the next one is refused.
export function isAtLimit(usage: number, limit: number | null | undefined): boolean {
  if (limit == null) return false;
  return usage >= limit;
}

// How many more can be created. null = unlimited. Never negative: a shop that
// downgraded below its current usage is over, not owed a negative allowance --
// and the CSV importer subtracts from this to decide how many rows it can take.
export function headroom(usage: number, limit: number | null | undefined): number | null {
  if (limit == null) return null;
  return Math.max(0, limit - usage);
}

export function describeLimit(resource: LimitResource, limit: number | null | undefined): string {
  const meta = LIMIT_RESOURCES.find((r) => r.key === resource);
  const noun = meta?.noun ?? 'record';
  if (limit == null) return `Unlimited ${noun}s`;
  return `${limit.toLocaleString()} ${noun}${limit === 1 ? '' : 's'}`;
}

// Whether the shop can still write at all. 'expired' and 'suspended' keep every
// read working -- a business must never lose sight of its own books over an
// unpaid invoice -- so this gates buttons, not screens.
export function canWrite(status: SubscriptionStatus): boolean {
  return status === 'trialing' || status === 'active' || status === 'grace';
}

export type LimitReached = { resource: LimitResource; limit: number; usage: number };

// Recognises the error the limit triggers raise (migration 20260818000300).
// PostgREST surfaces it as { message: 'limit_reached', details: '<json>' }, so
// the resource and the cap travel with the failure and the UI can name them
// rather than saying "something went wrong".
//
// Returns null for anything else, so callers keep their existing error path for
// real failures -- a network drop must not be reported as a plan limit.
export function parseLimitReached(error: unknown): LimitReached | null {
  const err = error as { message?: unknown; details?: unknown; detail?: unknown } | null;
  if (!err || typeof err !== 'object') return null;
  if (err.message !== 'limit_reached') return null;

  const raw = typeof err.details === 'string' ? err.details : typeof err.detail === 'string' ? err.detail : null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { resource?: string; limit?: number; usage?: number };
    if (!parsed.resource || typeof parsed.limit !== 'number' || typeof parsed.usage !== 'number') return null;
    if (!LIMIT_RESOURCES.some((r) => r.key === parsed.resource)) return null;
    return { resource: parsed.resource as LimitResource, limit: parsed.limit, usage: parsed.usage };
  } catch {
    return null;
  }
}

// The sibling of parseLimitReached for the module gates in migration
// 20260818000400. Same error vocabulary, different axis: a limit says "too
// many", a module says "not on your plan at all".
export function parseModuleNotIncluded(error: unknown): Module | null {
  const err = error as { message?: unknown; details?: unknown; detail?: unknown } | null;
  if (!err || typeof err !== 'object') return null;
  if (err.message !== 'module_not_included') return null;

  const raw = typeof err.details === 'string' ? err.details : typeof err.detail === 'string' ? err.detail : null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { module?: string };
    if (!parsed.module || !(ALL_MODULES as string[]).includes(parsed.module)) return null;
    return parsed.module as Module;
  } catch {
    return null;
  }
}

export function moduleNotIncludedMessage(module: Module): string {
  const meta = MODULES.find((m) => m.key === module);
  // Reassures in the same breath as refusing. Someone who just failed to save
  // needs to know their existing data is untouched, or they will assume the
  // worst about everything else on the screen.
  return `${meta?.label ?? 'This feature'} isn't included in your plan. Everything already saved is safe — upgrade under Settings → Plan and billing to make changes again.`;
}

// What to tell someone who just hit a cap. Says the number they're on, not just
// that they failed, and points at the two real ways out -- both of which the
// shop controls.
export function limitReachedMessage(hit: LimitReached): string {
  const meta = LIMIT_RESOURCES.find((r) => r.key === hit.resource);
  const noun = meta?.noun ?? 'record';
  const plural = `${noun}s`;
  if (hit.limit === 0) {
    return `Your plan doesn't include ${plural}. Upgrade to start adding them.`;
  }
  return `You've reached ${hit.limit.toLocaleString()} of ${hit.limit.toLocaleString()} ${plural} on your plan. Remove one, or upgrade to add more.`;
}

// One call for "was this refused by the plan, and if so what do I say". Returns
// null for anything else so a caller keeps its existing error handling intact:
//
//   setError(describePlanError(err) ?? extractErrorMessage(err, 'Could not save.'));
//
// Exists so each screen doesn't reimplement the two checks and drift on the
// wording -- a shop hitting a cap in Inventory and the same cap in an import
// should be told the same thing.
export function describePlanError(error: unknown): string | null {
  const limit = parseLimitReached(error);
  if (limit) return limitReachedMessage(limit);
  const module = parseModuleNotIncluded(error);
  if (module) return moduleNotIncludedMessage(module);
  return null;
}

// Whole days from now until `iso`, rounded up, floored at 0. Used for the trial
// countdown, which reads as a whole number of days to the shop owner: an
// expiry 30 hours out is "2 days left", because calling it 1 would have them
// plan to pay a day after they lose access.
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
