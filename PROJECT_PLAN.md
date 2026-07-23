# Ka Iibi project plan

This plan is kept in sync with the source so work can be resumed even if
chat history or session context is lost. Last updated 2026-07-22.

**Full detailed implementation plan (exact code, DB schema, task-by-task
steps):** `~/.claude/plans/i-want-to-set-sleepy-quail.md`
**Per-task completion ledger:** `.claude/worktrees/shop-owner-pos/.superpowers/sdd/progress.md`
**Worktree / branch:** `.claude/worktrees/shop-owner-pos`, branch `worktree-shop-owner-pos`
**Live Supabase project:** `jskobdvamobyigmmslrp` (URL/anon key in that worktree's `.env`, gitignored)

## Product direction

Ka Iibi is an Expo 57 app for a shop owner to manage a store: sign in, create
and maintain inventory, take in-person sales, and review sales activity. The
backend is Supabase and the target platforms are web and native Expo clients.
Phase 1 is shop-owner only (Dashboard + POS Sell + Inventory) — customer
accounts, purchase orders, suppliers, loyalty, multi-store, and roles are all
explicitly out of scope and deferred to later phases.

## Status: Phase 1 build complete, all 16 tasks + final review done

All 16 planned tasks are implemented, individually reviewed clean, and the
final whole-branch code review (2 fix rounds) is resolved. Branch
`worktree-shop-owner-pos` is ready for `superpowers:finishing-a-development-branch`
(merge / PR / further cleanup — not yet decided as of this update).

### What's built

- Expo SDK 57, centralized design tokens, currency utilities, Jest.
- Live Supabase project: full schema (profiles/shops/products/sales/sale_items),
  RLS policies + table grants, an atomic `complete_sale` checkout RPC with
  row-locking, a public-read product-images storage bucket. Three migrations
  (`0001_init`, `0002_storage`, `0003_grants`) apply cleanly in order.
- Real owner auth (email/password signup + login), `AuthProvider`/`useAuth()`.
- Route architecture: `(public)` (Discover/About/Signup/Login) and `(owner)`
  (Dashboard/Sell/Inventory/Sales, auth-gated), each further split into a
  `(tabs)` subgroup wrapped in an outer `Stack` so non-tab routes (product
  add/edit, login) push correctly over the tab bar on web and native.
- Inventory CRUD (SKU, barcode, brand, supplier, cost/price, stock, reorder
  level, shelf, expiry, batch, "expose to customers" toggle) + photo upload.
- POS Sell: product grid, cart, payment method (cash/zaad/edahab/other),
  atomic checkout, specific error messages on rejection (e.g. oversell).
- Sales history: today's metrics + transaction list.
- Dashboard: today's sales/orders/low-stock, 7-day revenue chart (plain
  Views, no chart library), top sellers, inventory alerts, recent
  transactions.
- Sign-out (web header + native Dashboard button), full session clearing.

### Unplanned fixes discovered and resolved during the build

All in the ledger with commit ranges; summarized here for a fast skim:

1. SDK 57 renamed `NativeTabs.Trigger`'s API (`options` prop → `.Label`/`.Icon`
   children) and `ThemeProvider`'s import source — folded into Task 1.
2. `web.output: static` crashed with `window is not defined` (Supabase client
   touched during Node prerendering) → switched to `single`.
3. `(public)/index.tsx` and `(owner)/index.tsx` both resolved to `/` — owner
   Dashboard moved to `(owner)/dashboard.tsx` (`/dashboard`).
4. `authenticated` role had RLS policies but no table-level `GRANT`s (raw-SQL
   migrations don't get Supabase Studio's automatic grants) → `0003_grants.sql`.
5. `expo-router/ui`'s `Tabs` (and native's `NativeTabs`) only render routes
   declared as tab triggers — `/product/new`/`/product/[id]` bounced back to
   a tab on web → both `(owner)` and `(public)` restructured into
   `(group)/(tabs)/` + an outer `Stack` for non-tab siblings.
6. New owner's `shop` stayed `null` in context until app reload (`signUpOwner`'s
   `SIGNED_IN` event fired before `createShop()` ran, and `refreshShop` was
   defined but never called) → fixed, plus a related race in the auth
   provider's request-sequencing (a single shared counter could drop the
   `profile` write) → split into independent per-field counters.
7. `npx tsc --noEmit` had 26 errors confined to test files (Jest globals
   type-resolution gap) → `"types": ["jest"]` added to `tsconfig.json`.

## Known follow-ups (not blocking, accepted for Phase 1)

- Native (iOS/Android) has never been verified on a real device/simulator in
  this sandbox — everything was verified via `expo start --web` + Playwright,
  or throwaway scripts hitting the live Supabase project directly. The
  navigation-shell fixes (#5 above) were reasoned to apply equally to native
  from reading `expo-router`'s source, but not empirically device-tested.
  **Do this before shipping.**
- No compensating action if `signUpOwner()` succeeds but `createShop()` then
  fails (leaves an auth user + profile with no shop, and re-signup with the
  same email would collide). Inherited from the plan's own code; flagged,
  not fixed — low likelihood, worth a re-entrant "finish creating your shop"
  path eventually.
- Editing a product's photo doesn't delete the old Storage object (orphaned
  files accumulate over time).
- `getTopSellingProducts` uses a rolling 7×24h window while
  `getDailyTotalsCents`/the revenue chart use 7 calendar days from local
  midnight — can disagree slightly at day boundaries. Cosmetic.
- `getDailyTotalsCents` caps at the most recent 500 sales — fine for Phase 1
  volume, revisit if/when a Reports phase needs longer history.
- No role gate on shop creation at the RLS level (`shops insert` only checks
  `owner_id = auth.uid()`, not `role = 'owner'`) — harmless today since no
  customer role exists yet, but worth tightening when it does.
- **Revoke the Supabase Management API personal access token** used to apply
  migrations during this build, at supabase.com/dashboard/account/tokens —
  it's no longer needed for anything and is broadly scoped.

## How to resume this build in a fresh session

1. `cd .claude/worktrees/shop-owner-pos && git status --short && git log --oneline -5`
2. `cat .superpowers/sdd/progress.md` — the ledger names the exact commit
   range and review outcome for every completed task and fix. Trust it over
   any recollection.
3. If picking up new work (Task 17+, i.e. a new phase): brainstorm and write
   a fresh plan with `superpowers:writing-plans`, then execute with
   `superpowers:subagent-driven-development`.
4. If finishing this branch (merge/PR/cleanup): use
   `superpowers:finishing-a-development-branch`.
5. Do not delete the worktree or run destructive git commands in it without
   checking `git status` first.
