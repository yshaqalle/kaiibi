# Help & Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A two-way message line between a store and the Kaiibi platform — a shop writes to us from the ☰ on any screen, an operator writes to a shop from the console, and both are the same thread.

**Architecture:** Two tables (`support_threads`, `support_messages`) plus an attachments table and a private storage bucket. The store writes directly through RLS-guarded inserts; the operator writes through the existing audited `platform-admin` edge function. One shared taxonomy module feeds both sides. The store's UI is a single `AppModal` with three views (compose / list / thread); the operator's is a new tab in the platform console.

**Tech Stack:** Expo SDK 57, React Native 0.86, expo-router, Supabase (Postgres + RLS + Edge Functions + Storage), Jest via `jest-expo`, `psql` for database tests.

## Global Constraints

- **Read the versioned Expo docs** at https://docs.expo.dev/versions/v57.0.0/ before writing code that touches an Expo API. This is a repo-wide rule from `AGENTS.md`.
- **Never hardcode a hex colour in a screen or component.** Every colour comes from `Colors.light` in `src/constants/theme.ts`. Card radius is `BENTO_RADIUS` (26).
- **Every file pins `const theme = Colors.light;`** — the app has no dark mode yet.
- **Never import `Modal` from `react-native`.** Use `AppModal` from `@/components/ui/app-modal`; `eslint.config.js` enforces this.
- **`Caveat tone="wrong"` must always carry an `action`.** A `wrong` with no fix is a `context`.
- **The support entry point is ungated.** It must never be wrapped in a permission or module check.
- **Kaiibi never sends a WhatsApp or email message itself.** The only outbound mechanism is a `wa.me` link the operator clicks.
- **TypeScript tests:** `npm test` (Jest). Pure logic lives in `src/lib/*.ts` with tests in `src/lib/__tests__/*.test.ts`.
- **Database tests:** `supabase/tests/verify-*.sql`, run with `psql`, wrapped in a `DO` block that raises at the end to roll everything back, printing `ALL CHECKS PASSED`.
- **Migration naming:** 14-digit timestamp prefix, e.g. `20260825000000_support_threads.sql`.
- **Commit after every task.** Do not push — this is a shared branch.

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/support-taxonomy.ts` | Categories, areas, labels, prompts. One source of truth for both sides. Pure — no imports from `supabase`. |
| `src/lib/support.ts` | Store-side types, queries, inserts, unread count, `wa.me` link building. |
| `src/lib/support-attachments.ts` | Upload/remove against the private bucket, plus size and count validation. |
| `src/components/support/support-menu-item.tsx` | The ☰ row and its unread badge, shared by all three shells. |
| `src/components/support/support-sheet.tsx` | The `AppModal` shell and the compose/list/thread view switch. |
| `src/components/support/support-compose.tsx` | The form. |
| `src/components/support/support-thread-view.tsx` | One conversation plus reply box (store side). |
| `src/components/support/attachment-picker.tsx` | Pick, list, remove, progress. Used by both sides. |
| `src/components/platform/support-tab.tsx` | Operator queue, reply panel, outbound composer. |
| `supabase/migrations/20260825000000_support_threads.sql` | Tables, sequence, RLS, bucket, policies. |
| `supabase/tests/verify-support.sql` | RLS and sequence verification. |
| `supabase/functions/platform-admin/index.ts` | Three new actions. |

**Modified:** `src/components/admin-sidebar.tsx`, `src/components/admin-tabs.tsx`, `src/components/admin-tabs.web.tsx`, `src/app/(admin)/_layout.tsx`, `src/app/platform/index.tsx`, `src/components/platform/shop-drawer.tsx`, `src/lib/platform.ts`.

---

### Task 1: The taxonomy module

Pure data and lookups, no dependencies. Everything else reads it, so it goes first.

**Files:**
- Create: `src/lib/support-taxonomy.ts`
- Test: `src/lib/__tests__/support-taxonomy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SupportCategory = 'broken' | 'help' | 'billing' | 'access' | 'data' | 'hardware' | 'feature' | 'other'`
  - `type OperatorCategory = 'billing' | 'account' | 'problem' | 'changed' | 'other'`
  - `type CategoryMeta = { key: SupportCategory; glyph: string; label: string; shortLabel: string; detailsLabel: string; detailsHint: string; areaLabel: string | null; areas: readonly AreaOption[] }`
  - `type AreaOption = { key: string; label: string }`
  - `const SUPPORT_CATEGORIES: readonly CategoryMeta[]`
  - `const OPERATOR_CATEGORIES: readonly { key: OperatorCategory; glyph: string; label: string }[]`
  - `function categoryMeta(key: SupportCategory): CategoryMeta`
  - `function isSupportCategory(value: unknown): value is SupportCategory`
  - `const OTHER_AREA_KEY = 'other'`
  - `function needsAreaOther(category: SupportCategory, area: string | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/support-taxonomy.test.ts`:

```ts
import {
  categoryMeta,
  isSupportCategory,
  needsAreaOther,
  OPERATOR_CATEGORIES,
  OTHER_AREA_KEY,
  SUPPORT_CATEGORIES,
  type SupportCategory,
} from '@/lib/support-taxonomy';

describe('SUPPORT_CATEGORIES', () => {
  it('offers the eight categories the store picks from', () => {
    expect(SUPPORT_CATEGORIES.map((c) => c.key)).toEqual([
      'broken', 'help', 'billing', 'access', 'data', 'hardware', 'feature', 'other',
    ]);
  });

  // Every one of these drives visible copy. A blank label ships an empty chip,
  // and a blank prompt is the whole reason the second field exists.
  it('gives every category a label, a details label and a hint', () => {
    for (const category of SUPPORT_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.shortLabel.length).toBeGreaterThan(0);
      expect(category.detailsLabel.length).toBeGreaterThan(0);
      expect(category.detailsHint.length).toBeGreaterThan(0);
      expect(category.glyph.length).toBeGreaterThan(0);
    }
  });

  // The capture mechanism only works if there is always something to capture
  // from -- a dropdown with no escape hatch silently loses the answers that
  // would have told us the list is wrong.
  it('ends every non-empty area list with the "other" escape hatch', () => {
    for (const category of SUPPORT_CATEGORIES) {
      if (category.areas.length === 0) {
        expect(category.areaLabel).toBeNull();
        continue;
      }
      expect(category.areaLabel).not.toBeNull();
      expect(category.areas[category.areas.length - 1].key).toBe(OTHER_AREA_KEY);
    }
  });

  it('gives "other" no dropdown of its own', () => {
    expect(categoryMeta('other').areas).toEqual([]);
    expect(categoryMeta('other').areaLabel).toBeNull();
  });

  it('has unique area keys within each category', () => {
    for (const category of SUPPORT_CATEGORIES) {
      const keys = category.areas.map((a) => a.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('categoryMeta', () => {
  it('finds each category by key', () => {
    expect(categoryMeta('billing').label).toBe('Billing or payment');
    expect(categoryMeta('broken').detailsLabel).toBe('What happened?');
  });

  it('throws on an unknown key rather than returning undefined', () => {
    expect(() => categoryMeta('nope' as SupportCategory)).toThrow(/unknown support category/i);
  });
});

describe('isSupportCategory', () => {
  it('accepts every real key and rejects anything else', () => {
    for (const category of SUPPORT_CATEGORIES) {
      expect(isSupportCategory(category.key)).toBe(true);
    }
    expect(isSupportCategory('urgent')).toBe(false);
    expect(isSupportCategory(null)).toBe(false);
    expect(isSupportCategory(3)).toBe(false);
  });
});

describe('needsAreaOther', () => {
  it('asks for free text when the picked area is the escape hatch', () => {
    expect(needsAreaOther('broken', OTHER_AREA_KEY)).toBe(true);
  });

  it('asks for free text whenever the category itself is "other"', () => {
    expect(needsAreaOther('other', null)).toBe(true);
  });

  it('does not ask otherwise', () => {
    expect(needsAreaOther('broken', 'pos')).toBe(false);
    expect(needsAreaOther('broken', null)).toBe(false);
  });
});

describe('OPERATOR_CATEGORIES', () => {
  // Deliberately shorter than the store's: an operator never files a feature
  // request or a hardware fault against a customer.
  it('is the shorter operator-side list', () => {
    expect(OPERATOR_CATEGORIES.map((c) => c.key)).toEqual([
      'billing', 'account', 'problem', 'changed', 'other',
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- support-taxonomy`
Expected: FAIL — `Cannot find module '@/lib/support-taxonomy'`.

- [ ] **Step 3: Write the module**

Create `src/lib/support-taxonomy.ts`:

```ts
// The one place the support taxonomy is defined. The store's sheet, the
// operator's filter chips and the database's check constraints all read from
// here, so adding a category is one edit rather than four.
//
// Two levels on purpose: the category says WHAT KIND of thing this is, the
// area says WHERE. The area is always optional -- someone whose till is
// frozen must never be blocked by a field about taxonomy.

export type SupportCategory =
  | 'broken'
  | 'help'
  | 'billing'
  | 'access'
  | 'data'
  | 'hardware'
  | 'feature'
  | 'other';

export type AreaOption = { key: string; label: string };

export type CategoryMeta = {
  key: SupportCategory;
  glyph: string;
  /** Full chip text, used when there is room. */
  label: string;
  /** Narrow-screen chip text. */
  shortLabel: string;
  detailsLabel: string;
  detailsHint: string;
  /** Label above the second dropdown; null when the category has no dropdown. */
  areaLabel: string | null;
  areas: readonly AreaOption[];
};

/**
 * The escape hatch every dropdown ends in. Picking it reveals a free-text box
 * whose answer is stored on the thread -- a category list guessed up front is
 * always wrong, and this is the mechanism that corrects it.
 */
export const OTHER_AREA_KEY = 'other';

// Mirrors the sidebar's own words (POS, Inventory, People, Accounting,
// Settings) so nobody has to translate what they were looking at into our
// vocabulary. Signing in and receipts are added because both sit outside the
// nav and both generate support.
const APP_AREAS: readonly AreaOption[] = [
  { key: 'pos', label: 'POS & checkout' },
  { key: 'inventory', label: 'Inventory & products' },
  { key: 'people', label: 'People & staff' },
  { key: 'customers', label: 'Customers' },
  { key: 'accounting', label: 'Accounting & reports' },
  { key: 'settings', label: 'Settings' },
  { key: 'signin', label: 'Signing in' },
  { key: 'receipts', label: 'Receipts & printing' },
  { key: OTHER_AREA_KEY, label: 'Somewhere else' },
];

export const SUPPORT_CATEGORIES: readonly CategoryMeta[] = [
  {
    key: 'broken',
    glyph: '🐞',
    label: "Something's broken",
    shortLabel: 'Broken',
    detailsLabel: 'What happened?',
    detailsHint:
      'Helps most: what you did, what you expected, what happened instead — and whether it happens every time.',
    areaLabel: 'Where in the app?',
    areas: APP_AREAS,
  },
  {
    key: 'help',
    glyph: '💬',
    label: 'I need help using it',
    shortLabel: 'Help',
    detailsLabel: 'What are you trying to do?',
    detailsHint: "What you're trying to get done, and where you got stuck.",
    areaLabel: 'Where in the app?',
    areas: APP_AREAS,
  },
  {
    key: 'billing',
    glyph: '💳',
    label: 'Billing or payment',
    shortLabel: 'Billing',
    detailsLabel: 'What do you need?',
    detailsHint: 'Helps most: the amount, the number you sent from, and the confirmation reference.',
    areaLabel: 'What kind?',
    areas: [
      { key: 'unmatched', label: "A payment I've made isn't showing" },
      { key: 'change_plan', label: 'I want to change plan' },
      { key: 'wrong_charge', label: 'I was charged wrong' },
      { key: 'invoice', label: 'I need an invoice or receipt' },
      { key: 'lapsed', label: "My plan lapsed and I'm locked out" },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'access',
    glyph: '🔐',
    label: 'Account or access',
    shortLabel: 'Access',
    detailsLabel: "What's happening?",
    detailsHint: 'Helps most: which email or phone you sign in with, and what it says when you try.',
    areaLabel: 'What kind?',
    areas: [
      { key: 'cant_sign_in', label: "I can't sign in" },
      { key: 'forgot_password', label: 'I forgot my password' },
      { key: 'wrong_role', label: "Someone's role is wrong" },
      { key: 'add_remove_person', label: 'Add or remove a person' },
      { key: 'add_branch', label: 'Add a branch' },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'data',
    glyph: '📊',
    label: 'Wrong numbers or missing data',
    shortLabel: 'Numbers',
    detailsLabel: "What's wrong, and what should it say?",
    detailsHint:
      'What it shows, what you expected, and roughly when it went wrong. The gap between the two is the whole report.',
    areaLabel: 'Which numbers?',
    areas: [
      { key: 'stock', label: 'Stock counts' },
      { key: 'sale', label: "A sale that's missing or duplicated" },
      { key: 'reports', label: 'Dashboard or reports' },
      { key: 'payroll', label: 'Payroll or hours' },
      { key: 'customers', label: 'Customer records' },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'hardware',
    glyph: '🖨',
    label: 'Scanner, printer or till',
    shortLabel: 'Hardware',
    detailsLabel: "What's it doing?",
    detailsHint: 'Helps most: the make and model if you know it, and whether it ever worked.',
    areaLabel: 'Which one?',
    areas: [
      { key: 'scanner', label: 'Barcode scanner' },
      { key: 'printer', label: 'Receipt printer' },
      { key: 'drawer', label: 'Cash drawer' },
      { key: 'terminal', label: 'Card or mobile-money terminal' },
      { key: 'device', label: 'The tablet or phone itself' },
      { key: OTHER_AREA_KEY, label: 'Something else' },
    ],
  },
  {
    key: 'feature',
    glyph: '✨',
    label: 'Feature request',
    shortLabel: 'Feature',
    detailsLabel: 'What would you like it to do?',
    detailsHint: "What you'd use it for. Knowing the job it does for you shapes what we build.",
    areaLabel: 'Where would it live?',
    areas: APP_AREAS,
  },
  {
    key: 'other',
    glyph: '🗒',
    label: 'Something else',
    shortLabel: 'Else',
    detailsLabel: 'Tell us more',
    detailsHint: 'Anything at all.',
    areaLabel: null,
    areas: [],
  },
];

export type OperatorCategory = 'billing' | 'account' | 'problem' | 'changed' | 'other';

// Shorter than the store's on purpose: an operator never files a feature
// request or a hardware fault against a customer.
export const OPERATOR_CATEGORIES: readonly { key: OperatorCategory; glyph: string; label: string }[] = [
  { key: 'billing', glyph: '💳', label: 'Billing' },
  { key: 'account', glyph: '🔐', label: 'Their account' },
  { key: 'problem', glyph: '🐞', label: 'A problem we found' },
  { key: 'changed', glyph: '📣', label: "Something's changed" },
  { key: 'other', glyph: '🗒', label: 'Something else' },
];

const CATEGORY_KEYS: readonly string[] = SUPPORT_CATEGORIES.map((category) => category.key);

export function isSupportCategory(value: unknown): value is SupportCategory {
  return typeof value === 'string' && CATEGORY_KEYS.includes(value);
}

// Throws rather than returning undefined: every caller renders the result
// straight into the UI, and a silent undefined there is a blank screen with no
// clue why.
export function categoryMeta(key: SupportCategory): CategoryMeta {
  const found = SUPPORT_CATEGORIES.find((category) => category.key === key);
  if (!found) throw new Error(`unknown support category: ${key}`);
  return found;
}

export function needsAreaOther(category: SupportCategory, area: string | null): boolean {
  if (category === 'other') return true;
  return area === OTHER_AREA_KEY;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- support-taxonomy`
Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support-taxonomy.ts src/lib/__tests__/support-taxonomy.test.ts
git commit -m "feat(support): taxonomy of categories and areas"
```

---

### Task 2: Database — tables, sequence, RLS, bucket

The visibility rules are the part to get right, so they get a real database test.

**Files:**
- Create: `supabase/migrations/20260825000000_support_threads.sql`
- Create: `supabase/tests/verify-support.sql`
- Modify: `supabase/tests/README.md` (add the run line and a "what it covers" section)

**Interfaces:**
- Consumes: `SupportCategory` keys from Task 1 (as check-constraint values).
- Produces: tables `public.support_threads`, `public.support_messages`, `public.support_attachments`; sequence `public.support_reference_seq`; bucket `support-attachments`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260825000000_support_threads.sql`:

```sql
-- Help & support: one thread per conversation, either end can open it.
--
-- A store reporting a broken scanner and an operator saying "your payment
-- cleared" are the same object. Building outbound as a separate announcement
-- table would split each store's history across two places and double the
-- policy surface.
--
-- The visibility rules below are the reason this file exists rather than a
-- pair of naive owns_shop() policies. A cashier writing to us about a manager
-- must not be readable by that manager, and billing belongs to the owner
-- rather than to whoever was on the till.

create sequence if not exists public.support_reference_seq start 2001;

-- Short enough to read down a phone line, which is how half of these get
-- followed up.
create or replace function public.next_support_reference()
returns text
language sql
volatile
as $$
  select 'KB-' || nextval('public.support_reference_seq')::text;
$$;

create table public.support_threads (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  reference text not null unique default public.next_support_reference(),

  -- Which end started it. Drives who can read it (policies below) and which
  -- message sits at the top of the thread.
  opened_by text not null check (opened_by in ('shop', 'platform')),
  -- The person who wrote the first message. Null when an operator opened it.
  author_user_id uuid references auth.users(id) on delete set null,
  -- Who an operator-opened thread is for. Null means "the store" -- readable
  -- by settings.access holders rather than by one person.
  addressed_user_id uuid references auth.users(id) on delete set null,

  category text not null,
  area text,
  -- The free-text capture behind every "something else". This is how the
  -- category list gets corrected from real traffic instead of guesses.
  area_other text,

  subject text not null check (length(btrim(subject)) > 0),
  status text not null default 'open' check (status in ('open', 'closed')),

  -- 'in_app' always works and is the default. 'whatsapp' and 'email' are
  -- flags for the operator, NOT delivery mechanisms -- nothing in this system
  -- sends a message on either channel.
  contact_preference text not null default 'in_app'
    check (contact_preference in ('in_app', 'whatsapp', 'email')),

  -- App version, platform, device class, the screen they were on, branch.
  -- Captured rather than asked for.
  client_context jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  -- Null means unread by that end. Compared against last_message_at rather
  -- than counted, so "unread" survives a message being edited or removed.
  shop_read_at timestamptz,
  platform_read_at timestamptz
);

create index support_threads_shop_idx on public.support_threads (shop_id, last_message_at desc);
create index support_threads_status_idx on public.support_threads (status, last_message_at desc);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.support_threads(id) on delete cascade,
  author_kind text not null check (author_kind in ('shop', 'platform')),
  author_user_id uuid references auth.users(id) on delete set null,
  body text not null check (length(btrim(body)) > 0),
  created_at timestamptz not null default now()
);

create index support_messages_thread_idx on public.support_messages (thread_id, created_at);

create table public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.support_messages(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  byte_size bigint not null,
  content_type text,
  created_at timestamptz not null default now()
);

create index support_attachments_message_idx on public.support_attachments (message_id);

-- Keeps last_message_at honest without every writer having to remember. The
-- unread comparison depends on it, so a missed update reads as "already seen".
create or replace function public.touch_support_thread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.support_threads
     set last_message_at = new.created_at,
         -- Writing marks it read for the end that wrote, and only that end.
         shop_read_at = case when new.author_kind = 'shop' then new.created_at else shop_read_at end,
         platform_read_at = case when new.author_kind = 'platform' then new.created_at else platform_read_at end
   where id = new.thread_id;
  return new;
end;
$$;

create trigger support_messages_touch_thread
  after insert on public.support_messages
  for each row execute function public.touch_support_thread();

------------------------------------------------------------------
-- Visibility
------------------------------------------------------------------
alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_attachments enable row level security;

-- The whole visibility rule in one place, so the message and attachment
-- policies cannot drift from the thread's.
create or replace function public.can_see_support_thread(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.support_threads t
     where t.id = p_thread_id
       and (
         -- Operators see everything. This is the back office.
         public.is_platform_admin()
         -- You always see what you wrote.
         or t.author_user_id = auth.uid()
         -- A thread we addressed to one person is that person's.
         or t.addressed_user_id = auth.uid()
         -- A thread we addressed to the STORE is for whoever runs it.
         or (
           t.opened_by = 'platform'
           and t.addressed_user_id is null
           and public.user_has_shop_permission(t.shop_id, 'settings.access')
         )
       )
  );
$$;

create policy "read a support thread you can see"
  on public.support_threads for select
  using (public.can_see_support_thread(id));

-- A store opens its own threads. Deliberately narrow: opened_by must be
-- 'shop' and the author must be you, so a member cannot forge a thread that
-- looks like it came from us -- which is what an operator-opened thread's
-- wider read policy would then expose to the whole shop.
create policy "a member opens their own support thread"
  on public.support_threads for insert
  with check (
    opened_by = 'shop'
    and author_user_id = auth.uid()
    and addressed_user_id is null
    and public.is_shop_member(shop_id)
  );

create policy "read messages on a thread you can see"
  on public.support_messages for select
  using (public.can_see_support_thread(thread_id));

create policy "reply to a thread you can see"
  on public.support_messages for insert
  with check (
    author_kind = 'shop'
    and author_user_id = auth.uid()
    and public.can_see_support_thread(thread_id)
  );

create policy "read attachments on a thread you can see"
  on public.support_attachments for select
  using (
    exists (
      select 1 from public.support_messages m
       where m.id = message_id and public.can_see_support_thread(m.thread_id)
    )
  );

create policy "attach to your own message"
  on public.support_attachments for insert
  with check (
    exists (
      select 1 from public.support_messages m
       where m.id = message_id and m.author_user_id = auth.uid()
    )
  );

------------------------------------------------------------------
-- Attachments bucket
------------------------------------------------------------------
-- NOT `product-images`. Two independent reasons: that bucket is public-read
-- (0002_storage.sql) and a support screenshot may show customer names and
-- sale totals; and its insert policy requires inventory.edit, settings.access
-- or staff.manage (0024, 20260820000300) -- precisely the permissions a stuck
-- cashier lacks, so their upload would 403.
insert into storage.buckets (id, name, public)
values ('support-attachments', 'support-attachments', false)
on conflict (id) do nothing;

-- First path segment is the shop id, so a member can only write under their
-- own shop and the object's owner is checkable without reading the row.
create policy "members upload their shop's support attachments"
  on storage.objects for insert
  with check (
    bucket_id = 'support-attachments'
    and public.is_shop_member((storage.foldername(name))[1]::uuid)
  );

create policy "members read their shop's support attachments"
  on storage.objects for select
  using (
    bucket_id = 'support-attachments'
    and (
      public.is_platform_admin()
      or public.is_shop_member((storage.foldername(name))[1]::uuid)
    )
  );

create policy "members delete their shop's support attachments"
  on storage.objects for delete
  using (
    bucket_id = 'support-attachments'
    and public.is_shop_member((storage.foldername(name))[1]::uuid)
  );
```

- [ ] **Step 2: Confirm the helper functions this migration leans on already exist**

Run:

```bash
grep -rn "function public.is_shop_member\|function public.user_has_shop_permission\|function public.is_platform_admin" supabase/migrations | sort
```

Expected: each of the three appears at least once in an earlier migration. If `is_shop_member` does not exist under that exact name, find the equivalent (likely in `0018_staff_shop_access.sql` or `0024_permission_gates.sql`) and substitute the real name throughout the migration before continuing. **Do not invent one.**

- [ ] **Step 3: Apply the migration from scratch**

Run:

```bash
supabase start
supabase db reset
```

Expected: every migration applies with no error. This also proves the whole chain still applies to an empty database, which pushing incrementally never checks.

- [ ] **Step 4: Write the database test**

Create `supabase/tests/verify-support.sql`:

```sql
-- Help & support visibility (migration 20260825000000).
--
-- The headline question is #4: a cashier's message to us must not be readable
-- by their manager. Everything before it establishes that threads and messages
-- exist and that the ordinary cases work, so a failure there is distinguishable
-- from a failure of the privacy rule itself.
--
-- Everything runs inside one DO block whose EXCEPTION clause rolls it all back.

\set ON_ERROR_STOP on

do $$
declare
  v_owner_id    uuid := gen_random_uuid();
  v_cashier_id  uuid := gen_random_uuid();
  v_outsider_id uuid := gen_random_uuid();
  v_shop_id uuid;
  v_cashier_thread uuid;
  v_store_thread uuid;
  v_msg_id uuid;
  v_count integer;
  v_ref_a text;
  v_ref_b text;
begin
  ------------------------------------------------------------------
  -- Fixture
  ------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    select u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
           'verify-support-' || u || '@example.test', '', now(), now(), now()
      from unnest(array[v_owner_id, v_cashier_id, v_outsider_id]) u;

  insert into public.shops (owner_id, name) values (v_owner_id, 'Support Test Shop')
    returning id into v_shop_id;

  ------------------------------------------------------------------
  raise notice '=== 1. References are unique and increasing ===';
  ------------------------------------------------------------------
  select public.next_support_reference() into v_ref_a;
  select public.next_support_reference() into v_ref_b;
  if v_ref_a = v_ref_b then raise exception 'FAIL: reference repeated: %', v_ref_a; end if;
  if v_ref_a !~ '^KB-[0-9]+$' then raise exception 'FAIL: bad reference shape: %', v_ref_a; end if;
  raise notice 'OK: % then %', v_ref_a, v_ref_b;

  ------------------------------------------------------------------
  raise notice '=== 2. A thread gets a reference and an open status by default ===';
  ------------------------------------------------------------------
  insert into public.support_threads (shop_id, opened_by, author_user_id, category, subject)
    values (v_shop_id, 'shop', v_cashier_id, 'broken', 'Scanner stops after a refund')
    returning id into v_cashier_thread;

  perform 1 from public.support_threads
    where id = v_cashier_thread and status = 'open' and reference like 'KB-%';
  if not found then raise exception 'FAIL: thread defaults are wrong'; end if;
  raise notice 'OK: thread opened with a reference and status open';

  ------------------------------------------------------------------
  raise notice '=== 3. A message advances last_message_at and marks its own end read ===';
  ------------------------------------------------------------------
  update public.support_threads
     set last_message_at = now() - interval '1 day', shop_read_at = null, platform_read_at = null
   where id = v_cashier_thread;

  insert into public.support_messages (thread_id, author_kind, author_user_id, body)
    values (v_cashier_thread, 'shop', v_cashier_id, 'It beeps but nothing lands in the cart.')
    returning id into v_msg_id;

  -- Writing marks it read for the writer and leaves the other end unread --
  -- that asymmetry is the whole unread count.
  perform 1 from public.support_threads
    where id = v_cashier_thread
      and last_message_at > now() - interval '1 minute'
      and shop_read_at is not null
      and platform_read_at is null;
  if not found then raise exception 'FAIL: trigger did not touch the thread correctly'; end if;
  raise notice 'OK: last_message_at advanced, shop read, platform unread';

  ------------------------------------------------------------------
  raise notice '=== 4. A cashier''s thread is invisible to the shop owner ===';
  ------------------------------------------------------------------
  -- The question the privacy rule exists to answer.
  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);

  select count(*) into v_count from public.support_threads where id = v_cashier_thread;
  if v_count <> 0 then raise exception 'FAIL: the owner can read a cashier''s support thread'; end if;

  select count(*) into v_count from public.support_messages where thread_id = v_cashier_thread;
  if v_count <> 0 then raise exception 'FAIL: the owner can read a cashier''s support messages'; end if;
  raise notice 'OK: the owner sees neither the thread nor its messages';

  ------------------------------------------------------------------
  raise notice '=== 5. The cashier still sees their own ===';
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);

  select count(*) into v_count from public.support_threads where id = v_cashier_thread;
  if v_count <> 1 then raise exception 'FAIL: the author cannot read their own thread'; end if;
  raise notice 'OK: the author reads their own thread';

  ------------------------------------------------------------------
  raise notice '=== 6. A store-addressed thread from us IS the owner''s ===';
  ------------------------------------------------------------------
  reset role;
  insert into public.support_threads
    (shop_id, opened_by, author_user_id, addressed_user_id, category, subject)
    values (v_shop_id, 'platform', null, null, 'billing', 'Your ZAAD payment cleared')
    returning id into v_store_thread;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.support_threads where id = v_store_thread;
  if v_count <> 1 then raise exception 'FAIL: the owner cannot read a thread addressed to the store'; end if;

  -- ...and NOT the cashier's: billing belongs to whoever runs the shop.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.support_threads where id = v_store_thread;
  if v_count <> 0 then raise exception 'FAIL: a cashier can read a store-addressed billing thread'; end if;
  raise notice 'OK: store-addressed reaches settings.access holders only';

  ------------------------------------------------------------------
  raise notice '=== 7. Someone from another shop sees nothing ===';
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_outsider_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.support_threads where shop_id = v_shop_id;
  if v_count <> 0 then raise exception 'FAIL: an outsider can read this shop''s threads'; end if;
  raise notice 'OK: an outsider reads nothing';

  ------------------------------------------------------------------
  raise notice '=== 8. A member cannot forge a thread that looks like ours ===';
  ------------------------------------------------------------------
  -- An operator-opened thread has the wider read policy, so letting a member
  -- write opened_by = 'platform' would let them expose their own message to
  -- the whole shop -- or read one addressed to someone else.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_cashier_id, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin
    insert into public.support_threads (shop_id, opened_by, author_user_id, category, subject)
      values (v_shop_id, 'platform', v_cashier_id, 'billing', 'Forged');
    raise exception 'FAIL: a member inserted a platform-opened thread';
  exception when insufficient_privilege or check_violation then
    raise notice 'OK: refused';
  end;

  reset role;
  raise notice 'ALL CHECKS PASSED';
  raise exception 'rollback: verification complete';
exception when others then
  if sqlerrm = 'rollback: verification complete' then
    raise notice 'Rolled back cleanly.';
  else
    raise;
  end if;
end $$;
```

- [ ] **Step 5: Run the database test**

Run:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-support.sql
```

Expected: a run of `OK:` notices ending in `ALL CHECKS PASSED` and `Rolled back cleanly.`

If check 4 fails, the privacy rule is wrong — fix `can_see_support_thread`, re-run `supabase db reset`, and run again. Do not proceed past a failing check 4.

- [ ] **Step 6: Document it in the tests README**

Add `supabase/tests/verify-support.sql` to the run list in `supabase/tests/README.md`, and a section:

```markdown
## What `verify-support.sql` covers

1. `KB-####` references are unique and increasing.
2. A thread defaults to open with a reference.
3. Posting a message advances `last_message_at` and marks the thread read for
   the end that wrote it and **only** that end — the asymmetry the unread count
   is built on.
4. **A cashier's message to us is invisible to the shop owner.** The question
   the whole policy exists to answer: a staff member reporting their manager
   must not be reporting them to their manager.
5. The author still reads their own.
6. A thread *we* address to the store reaches `settings.access` holders and not
   the cashier — billing belongs to whoever runs the shop.
7. A member of another shop reads nothing.
8. A member cannot insert a thread claiming `opened_by = 'platform'`, which
   would otherwise let them borrow the wider read policy that grant carries.
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260825000000_support_threads.sql supabase/tests/verify-support.sql supabase/tests/README.md
git commit -m "feat(support): threads, messages and attachments with per-author visibility"
```

---

### Task 3: Store-side data layer

**Files:**
- Create: `src/lib/support.ts`
- Test: `src/lib/__tests__/support.test.ts`

**Interfaces:**
- Consumes: `SupportCategory`, `needsAreaOther` from Task 1; the tables from Task 2.
- Produces:
  - `type SupportThread`, `type SupportMessage`, `type ContactPreference = 'in_app' | 'whatsapp' | 'email'`
  - `type DraftValidation = { ok: true } | { ok: false; field: 'category' | 'subject' | 'details' | 'areaOther'; message: string }`
  - `function validateDraft(draft: SupportDraft): DraftValidation`
  - `function buildClientContext(input: ClientContextInput): Record<string, string>`
  - `function whatsAppLink(phone: string, message: string): string | null`
  - `function unreadCount(threads: SupportThread[]): number`
  - `async function listMyThreads(): Promise<SupportThread[]>`
  - `async function listMessages(threadId: string): Promise<SupportMessage[]>`
  - `async function createThread(shopId: string, userId: string, draft: SupportDraft, context: Record<string, string>): Promise<SupportThread>`
  - `async function postReply(threadId: string, body: string, userId: string): Promise<SupportMessage>`
  - `async function markThreadRead(threadId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/support.test.ts`:

```ts
import {
  buildClientContext,
  unreadCount,
  validateDraft,
  whatsAppLink,
  type SupportDraft,
  type SupportThread,
} from '@/lib/support';

const validDraft: SupportDraft = {
  category: 'broken',
  area: 'pos',
  areaOther: '',
  subject: 'Scanner stops reading after a refund',
  details: 'It beeps but nothing lands in the cart.',
  contactPreference: 'in_app',
};

function thread(over: Partial<SupportThread>): SupportThread {
  return {
    id: 'thread-1',
    reference: 'KB-2481',
    subject: 'Subject',
    category: 'broken',
    area: null,
    areaOther: null,
    status: 'open',
    openedBy: 'shop',
    contactPreference: 'in_app',
    lastMessageAt: '2026-08-09T10:00:00.000Z',
    shopReadAt: '2026-08-09T10:00:00.000Z',
    createdAt: '2026-08-09T09:00:00.000Z',
    ...over,
  };
}

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateDraft(validDraft)).toEqual({ ok: true });
  });

  it('names the first empty required field', () => {
    expect(validateDraft({ ...validDraft, subject: '   ' })).toEqual({
      ok: false,
      field: 'subject',
      message: 'Give this a short subject so we can find it again.',
    });
    expect(validateDraft({ ...validDraft, details: '' }).ok).toBe(false);
    expect(validateDraft({ ...validDraft, category: null }).ok).toBe(false);
  });

  // The area itself is optional on purpose -- someone whose till is frozen
  // must not be blocked by a field about taxonomy.
  it('accepts a draft with no area', () => {
    expect(validateDraft({ ...validDraft, area: null })).toEqual({ ok: true });
  });

  // ...but if they reached for the escape hatch, the capture is the point.
  it('requires the free text once "something else" is picked', () => {
    const draft = { ...validDraft, area: 'other', areaOther: '' };
    expect(validateDraft(draft)).toEqual({
      ok: false,
      field: 'areaOther',
      message: 'Tell us in a few words what this is about.',
    });
    expect(validateDraft({ ...draft, areaOther: 'Training' })).toEqual({ ok: true });
  });

  it('requires the free text for the "other" category too', () => {
    expect(validateDraft({ ...validDraft, category: 'other', area: null, areaOther: '' }).ok).toBe(false);
  });

  it('refuses details longer than the column allows', () => {
    const result = validateDraft({ ...validDraft, details: 'x'.repeat(4001) });
    expect(result).toEqual({ ok: false, field: 'details', message: 'That is longer than we can store — please trim it to 4000 characters.' });
  });
});

describe('buildClientContext', () => {
  it('records what we know about where this came from', () => {
    expect(
      buildClientContext({
        appVersion: '1.4.2',
        buildNumber: '118',
        platform: 'android',
        isTablet: true,
        screen: '/pos',
        locationName: 'Main branch',
      })
    ).toEqual({
      appVersion: '1.4.2',
      buildNumber: '118',
      platform: 'android',
      deviceClass: 'tablet',
      screen: '/pos',
      locationName: 'Main branch',
    });
  });

  it('omits what it does not know rather than writing "undefined"', () => {
    const context = buildClientContext({
      appVersion: null,
      buildNumber: null,
      platform: 'web',
      isTablet: false,
      screen: '/dashboard',
      locationName: null,
    });
    expect(context).toEqual({ platform: 'web', deviceClass: 'phone', screen: '/dashboard' });
    expect(Object.values(context).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
  });
});

describe('whatsAppLink', () => {
  // wa.me takes digits only -- a leading + or any spacing gives a dead link
  // rather than an error, which is the worst kind of failure here.
  it('strips everything but digits from the number', () => {
    expect(whatsAppLink('+252 63 442 1180', 'hi')).toBe('https://wa.me/252634421180?text=hi');
  });

  it('percent-encodes the message', () => {
    expect(whatsAppLink('252634421180', 'Found it — fixed in 1.4.3')).toBe(
      'https://wa.me/252634421180?text=Found%20it%20%E2%80%94%20fixed%20in%201.4.3'
    );
  });

  it('returns null when there is no usable number', () => {
    expect(whatsAppLink('', 'hi')).toBeNull();
    expect(whatsAppLink('   ', 'hi')).toBeNull();
    expect(whatsAppLink('not a phone', 'hi')).toBeNull();
  });
});

describe('unreadCount', () => {
  it('counts threads whose last message arrived after the store last looked', () => {
    expect(
      unreadCount([
        thread({ id: 'a', lastMessageAt: '2026-08-09T12:00:00.000Z', shopReadAt: '2026-08-09T11:00:00.000Z' }),
        thread({ id: 'b', lastMessageAt: '2026-08-09T12:00:00.000Z', shopReadAt: '2026-08-09T12:00:00.000Z' }),
      ])
    ).toBe(1);
  });

  it('treats a never-read thread as unread', () => {
    expect(unreadCount([thread({ shopReadAt: null })])).toBe(1);
  });

  it('is zero for an empty list', () => {
    expect(unreadCount([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- __tests__/support.test`
Expected: FAIL — `Cannot find module '@/lib/support'`.

- [ ] **Step 3: Write the module**

Create `src/lib/support.ts`:

```ts
import { supabase } from '@/lib/supabase';
import { needsAreaOther, type SupportCategory } from '@/lib/support-taxonomy';

export type ContactPreference = 'in_app' | 'whatsapp' | 'email';

// Matches the column's check constraint (migration 20260825000000). Trimming
// here and rejecting there means the same limit is enforced twice on purpose:
// the client message is kind, the column is the rule.
const DETAILS_MAX = 4000;

export type SupportDraft = {
  category: SupportCategory | null;
  area: string | null;
  areaOther: string;
  subject: string;
  details: string;
  contactPreference: ContactPreference;
};

export type SupportThread = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  area: string | null;
  areaOther: string | null;
  status: 'open' | 'closed';
  openedBy: 'shop' | 'platform';
  contactPreference: ContactPreference;
  lastMessageAt: string;
  shopReadAt: string | null;
  createdAt: string;
};

export type SupportMessage = {
  id: string;
  threadId: string;
  authorKind: 'shop' | 'platform';
  body: string;
  createdAt: string;
  attachments: { id: string; fileName: string; storagePath: string; byteSize: number }[];
};

export type DraftValidation =
  | { ok: true }
  | { ok: false; field: 'category' | 'subject' | 'details' | 'areaOther'; message: string };

// Ordered top-to-bottom so the message lands under the first field the reader
// would fix, rather than under whichever check happened to run first.
export function validateDraft(draft: SupportDraft): DraftValidation {
  if (!draft.category) {
    return { ok: false, field: 'category', message: 'Pick what this is about.' };
  }
  if (needsAreaOther(draft.category, draft.area) && !draft.areaOther.trim()) {
    return { ok: false, field: 'areaOther', message: 'Tell us in a few words what this is about.' };
  }
  if (!draft.subject.trim()) {
    return { ok: false, field: 'subject', message: 'Give this a short subject so we can find it again.' };
  }
  if (!draft.details.trim()) {
    return { ok: false, field: 'details', message: 'Tell us what is going on — even a sentence helps.' };
  }
  if (draft.details.length > DETAILS_MAX) {
    return {
      ok: false,
      field: 'details',
      message: `That is longer than we can store — please trim it to ${DETAILS_MAX} characters.`,
    };
  }
  return { ok: true };
}

export type ClientContextInput = {
  appVersion: string | null;
  buildNumber: string | null;
  platform: string;
  isTablet: boolean;
  screen: string;
  locationName: string | null;
};

// Everything the person would otherwise be asked for and get wrong. Absent
// values are omitted rather than written as empty strings, so the operator's
// rail can tell "we don't know" from "it said nothing".
export function buildClientContext(input: ClientContextInput): Record<string, string> {
  const context: Record<string, string> = {
    platform: input.platform,
    deviceClass: input.isTablet ? 'tablet' : 'phone',
    screen: input.screen,
  };
  if (input.appVersion) context.appVersion = input.appVersion;
  if (input.buildNumber) context.buildNumber = input.buildNumber;
  if (input.locationName) context.locationName = input.locationName;
  return context;
}

// wa.me wants digits only. A leading '+' or any spacing produces a link that
// opens WhatsApp on a blank screen rather than erroring, which is the worst
// failure available here -- hence null instead of a best-effort URL.
export function whatsAppLink(phone: string, message: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function unreadCount(threads: SupportThread[]): number {
  return threads.filter(
    (thread) => !thread.shopReadAt || Date.parse(thread.lastMessageAt) > Date.parse(thread.shopReadAt)
  ).length;
}

function toThread(row: any): SupportThread {
  return {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    area: row.area,
    areaOther: row.area_other,
    status: row.status,
    openedBy: row.opened_by,
    contactPreference: row.contact_preference,
    lastMessageAt: row.last_message_at,
    shopReadAt: row.shop_read_at,
    createdAt: row.created_at,
  };
}

// No shop filter: RLS already decides what this person can see, and adding a
// client-side one would quietly hide a thread the policy meant them to have.
export async function listMyThreads(): Promise<SupportThread[]> {
  const { data, error } = await supabase
    .from('support_threads')
    .select('*')
    .order('last_message_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toThread);
}

export async function listMessages(threadId: string): Promise<SupportMessage[]> {
  const { data, error } = await supabase
    .from('support_messages')
    .select('*, support_attachments(id, file_name, storage_path, byte_size)')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id,
    threadId: row.thread_id,
    authorKind: row.author_kind,
    body: row.body,
    createdAt: row.created_at,
    attachments: (row.support_attachments ?? []).map((a: any) => ({
      id: a.id,
      fileName: a.file_name,
      storagePath: a.storage_path,
      byteSize: a.byte_size,
    })),
  }));
}

export async function createThread(
  shopId: string,
  userId: string,
  draft: SupportDraft,
  context: Record<string, string>
): Promise<SupportThread> {
  const validation = validateDraft(draft);
  if (!validation.ok) throw new Error(validation.message);

  const { data, error } = await supabase
    .from('support_threads')
    .insert({
      shop_id: shopId,
      opened_by: 'shop',
      author_user_id: userId,
      category: draft.category,
      area: draft.area,
      area_other: draft.areaOther.trim() || null,
      subject: draft.subject.trim(),
      contact_preference: draft.contactPreference,
      client_context: context,
    })
    .select('*')
    .single();
  if (error) throw error;

  await postReply(data.id, draft.details.trim(), userId);
  return toThread(data);
}

export async function postReply(threadId: string, body: string, userId: string): Promise<SupportMessage> {
  const { data, error } = await supabase
    .from('support_messages')
    .insert({ thread_id: threadId, author_kind: 'shop', author_user_id: userId, body: body.trim() })
    .select('*')
    .single();
  if (error) throw error;
  return { id: data.id, threadId, authorKind: 'shop', body: data.body, createdAt: data.created_at, attachments: [] };
}

export async function markThreadRead(threadId: string): Promise<void> {
  const { error } = await supabase
    .from('support_threads')
    .update({ shop_read_at: new Date().toISOString() })
    .eq('id', threadId);
  if (error) throw error;
}
```

- [ ] **Step 4: Add the update policy the read marker needs**

`markThreadRead` writes to `support_threads`, and Task 2's migration has no UPDATE policy — the write silently affects zero rows. Append to `supabase/migrations/20260825000000_support_threads.sql`:

```sql
-- Narrow on purpose: marking a thread read is the ONLY thing a store may
-- update on it. A broad "update your own thread" policy would let a member
-- rewrite the subject or reopen something we closed.
create policy "mark your own thread read"
  on public.support_threads for update
  using (public.can_see_support_thread(id))
  with check (public.can_see_support_thread(id));

revoke update on public.support_threads from authenticated;
grant update (shop_read_at) on public.support_threads to authenticated;
```

Then re-run `supabase db reset` and `psql … -f supabase/tests/verify-support.sql` to confirm the chain still applies and the checks still pass.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- __tests__/support.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/support.ts src/lib/__tests__/support.test.ts supabase/migrations/20260825000000_support_threads.sql
git commit -m "feat(support): store-side data layer with draft validation and unread counting"
```

---

### Task 4: Attachment upload

**Files:**
- Create: `src/lib/support-attachments.ts`
- Test: `src/lib/__tests__/support-attachments.test.ts`

**Interfaces:**
- Consumes: bucket `support-attachments` from Task 2.
- Produces:
  - `type PendingAttachment = { uri: string; fileName: string; byteSize: number; contentType: string | null }`
  - `const MAX_ATTACHMENTS = 5`, `const MAX_BYTES = 10 * 1024 * 1024`, `const WARN_BYTES = 5 * 1024 * 1024`
  - `function checkAttachment(existing: PendingAttachment[], next: PendingAttachment): AttachmentCheck`
  - `function attachmentPath(shopId: string, threadId: string, fileName: string, now: number): string`
  - `async function uploadAttachment(path: string, file: PendingAttachment): Promise<void>`
  - `async function signedUrlFor(storagePath: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/support-attachments.test.ts`:

```ts
import {
  attachmentPath,
  checkAttachment,
  MAX_ATTACHMENTS,
  MAX_BYTES,
  WARN_BYTES,
  type PendingAttachment,
} from '@/lib/support-attachments';

function file(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return { uri: 'file:///tmp/a.png', fileName: 'a.png', byteSize: 1024, contentType: 'image/png', ...over };
}

describe('checkAttachment', () => {
  it('accepts a small file when there is room', () => {
    expect(checkAttachment([], file())).toEqual({ ok: true, warn: null });
  });

  // Named limits, not "too big" -- an error that doesn't say the limit makes
  // the person guess how much to trim.
  it('refuses a file over the size cap and names the cap', () => {
    expect(checkAttachment([], file({ byteSize: MAX_BYTES + 1 }))).toEqual({
      ok: false,
      message: 'That file is over 10 MB. Try a screenshot instead of a video, or send it in two parts.',
    });
  });

  it('refuses more than the count cap and names the cap', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS }, () => file());
    expect(checkAttachment(full, file())).toEqual({
      ok: false,
      message: 'You can attach 5 files to one message. Remove one to add another.',
    });
  });

  // A clip is the most useful bug attachment and the most expensive one on a
  // metered connection, so it warns rather than refusing.
  it('warns but accepts a large file under the cap', () => {
    const result = checkAttachment([], file({ byteSize: WARN_BYTES + 1 }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.warn).toMatch(/may take a while/i);
  });
});

describe('attachmentPath', () => {
  // The first segment must be the shop id -- the bucket policy reads it with
  // storage.foldername(name)[1] and a different shape 403s.
  it('starts with the shop id and keeps the extension', () => {
    const path = attachmentPath('shop-1', 'thread-9', 'cart empty.png', 1754_700_000_000);
    expect(path.startsWith('shop-1/thread-9/')).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
  });

  it('is unique per upload so an upsert:false write never collides', () => {
    const a = attachmentPath('shop-1', 'thread-9', 'a.png', 1);
    const b = attachmentPath('shop-1', 'thread-9', 'a.png', 2);
    expect(a).not.toBe(b);
  });

  it('strips characters that would break the path', () => {
    const path = attachmentPath('shop-1', 'thread-9', 'my report (final)/v2.pdf', 1);
    expect(path.split('/').length).toBe(3);
    expect(path).toMatch(/^shop-1\/thread-9\/[A-Za-z0-9._-]+$/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- support-attachments`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `src/lib/support-attachments.ts`:

```ts
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

// Deliberately NOT src/lib/storage.ts. That module is hardcoded to the public
// `product-images` bucket, and its own comment is explicit that its permission
// story is bucket-specific: an insert there requires inventory.edit,
// settings.access or staff.manage, which is exactly what a stuck cashier
// lacks. Support uploads go to a private bucket any shop member can write to.
const BUCKET = 'support-attachments';

export const MAX_ATTACHMENTS = 5;
export const MAX_BYTES = 10 * 1024 * 1024;
export const WARN_BYTES = 5 * 1024 * 1024;

export type PendingAttachment = {
  uri: string;
  fileName: string;
  byteSize: number;
  contentType: string | null;
};

export type AttachmentCheck = { ok: true; warn: string | null } | { ok: false; message: string };

export function checkAttachment(existing: PendingAttachment[], next: PendingAttachment): AttachmentCheck {
  if (existing.length >= MAX_ATTACHMENTS) {
    return {
      ok: false,
      message: `You can attach ${MAX_ATTACHMENTS} files to one message. Remove one to add another.`,
    };
  }
  if (next.byteSize > MAX_BYTES) {
    return {
      ok: false,
      message: 'That file is over 10 MB. Try a screenshot instead of a video, or send it in two parts.',
    };
  }
  if (next.byteSize > WARN_BYTES) {
    return { ok: true, warn: 'That is a big file — it may take a while to send on a slow connection.' };
  }
  return { ok: true, warn: null };
}

// The first segment MUST be the shop id: the bucket policy reads it with
// storage.foldername(name)[1] and any other shape gets a 403 rather than a
// helpful error. The timestamp keeps every write unique, because uploads use
// upsert:false and a collision fails the send.
export function attachmentPath(shopId: string, threadId: string, fileName: string, now: number): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, '-').slice(-60);
  return `${shopId}/${threadId}/${now}-${safe}`;
}

export async function uploadAttachment(path: string, file: PendingAttachment): Promise<void> {
  // Same platform split as src/lib/storage.ts, and for the same reason: on
  // native, `fetch(uri).blob()` returns React Native's Blob polyfill, which
  // has no arrayBuffer(); on web, expo-file-system's File class is a no-op
  // stub. Neither works on both.
  const body: Blob | Uint8Array =
    Platform.OS === 'web' ? await (await fetch(file.uri)).blob() : await new File(file.uri).bytes();

  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType: file.contentType ?? 'application/octet-stream',
    upsert: false,
  });
  if (error) throw error;
}

// The bucket is private, so reads need a signed URL rather than getPublicUrl.
// One hour is long enough to open an attachment and short enough that a
// copied link stops working before it can be passed around.
export async function signedUrlFor(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- support-attachments`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/support-attachments.ts src/lib/__tests__/support-attachments.test.ts
git commit -m "feat(support): private-bucket attachment upload with named limits"
```

---

### Task 5: The ☰ menu row

The smallest visible slice. After this task the row is in all three shells and opens a placeholder sheet.

**Files:**
- Create: `src/components/support/support-menu-item.tsx`
- Modify: `src/components/admin-sidebar.tsx:126-155` (inside the `AppModal` menu sheet)
- Modify: `src/components/admin-tabs.tsx` (its `AppModal` menu sheet)
- Modify: `src/components/admin-tabs.web.tsx` (its `AppModal` menu sheet)

**Interfaces:**
- Consumes: `unreadCount`, `listMyThreads` from Task 3.
- Produces:
  - `function SupportMenuItem({ onPress }: { onPress: () => void })`
  - `function useSupportUnread(): { count: number; refresh: () => Promise<void> }`

- [ ] **Step 1: Write the shared component**

Create `src/components/support/support-menu-item.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { listMyThreads, unreadCount } from '@/lib/support';

const theme = Colors.light;

// One component for a row that exists in three shells -- admin-sidebar.tsx
// (wide), admin-tabs.web.tsx (mobile web) and admin-tabs.tsx (native phone).
// Pasting it three times is how the three menus drift.
//
// Deliberately NOT gated. The Settings row beside it is wrapped in
// canEditShop; this one must never be, because a cashier who cannot ring up a
// sale is the person most likely to need it -- and today their whole menu is
// one item: Sign out.
export function SupportMenuItem({ onPress }: { onPress: () => void }) {
  const { count } = useSupportUnread();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}>
      <Text style={styles.icon}>✉</Text>
      <Text style={styles.label}>Help &amp; support</Text>
      {count > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count > 9 ? '9+' : String(count)}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function useSupportUnread() {
  const { session } = useAuth();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!session) {
      setCount(0);
      return;
    }
    try {
      setCount(unreadCount(await listMyThreads()));
    } catch {
      // A failed count must never break the menu it lives in. No badge is a
      // better outcome than no menu.
      setCount(0);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { count, refresh };
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  icon: { fontSize: 15, color: theme.bentoInk },
  label: { fontSize: 14, fontWeight: '700', color: theme.bentoInk, flex: 1 },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.bentoAccentWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontWeight: '800', color: theme.bentoAccentInk },
});
```

- [ ] **Step 2: Add the row to the wide sidebar**

In `src/components/admin-sidebar.tsx`, import at the top:

```tsx
import { SupportMenuItem } from '@/components/support/support-menu-item';
```

Add `const [supportOpen, setSupportOpen] = useState(false);` beside the existing `menuOpen` state, then inside the menu sheet — **after** the `canEditShop && (…Settings…)` fragment and **before** the `menuDivider` that precedes Sign out — insert:

```tsx
<SupportMenuItem
  onPress={() => {
    setMenuOpen(false);
    setSupportOpen(true);
  }}
/>
<View style={styles.menuDivider} />
```

Note the existing Settings fragment already renders its own `menuDivider`; keep exactly one divider between the support row and Sign out, so the menu reads Settings / Help & support / rule / Sign out.

- [ ] **Step 3: Add the same row to the other two shells**

Repeat Step 2's edit in `src/components/admin-tabs.tsx` and `src/components/admin-tabs.web.tsx`. Each already has its own `menuOpen` state and menu sheet with the same structure; add `supportOpen` state and the same two elements in the same position. Use each file's own `styles.menuDivider`.

- [ ] **Step 4: Verify it renders on web**

Run: `npm run web`

Open the app, sign in, click ☰. Expected: the menu reads **Settings**, **Help & support**, a rule, **Sign out**. The support row shows no badge (no threads yet). Nothing happens on press — the sheet arrives in Task 7.

Sign in as a cashier (a member whose role lacks `settings.access`) and confirm the menu reads **Help & support**, rule, **Sign out** — the support row is present without Settings.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/components/support/support-menu-item.tsx src/components/admin-sidebar.tsx src/components/admin-tabs.tsx src/components/admin-tabs.web.tsx
git commit -m "feat(support): ungated Help & support row in all three shell menus"
```

---

### Task 6: The compose form

**Files:**
- Create: `src/components/support/attachment-picker.tsx`
- Create: `src/components/support/support-compose.tsx`

**Interfaces:**
- Consumes: taxonomy (Task 1), `SupportDraft`/`validateDraft` (Task 3), attachment limits (Task 4).
- Produces:
  - `function AttachmentPicker({ files, onChange }: { files: PendingAttachment[]; onChange: (files: PendingAttachment[]) => void })`
  - `function SupportCompose({ onSent }: { onSent: (reference: string) => void })`
  - `async function readStoredDraft(): Promise<SupportDraft | null>`
  - `function writeStoredDraft(draft: SupportDraft): void`
  - `function clearStoredDraft(): void`

- [ ] **Step 1: Write the attachment picker**

Create `src/components/support/attachment-picker.tsx`:

```tsx
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { checkAttachment, MAX_ATTACHMENTS, type PendingAttachment } from '@/lib/support-attachments';

const theme = Colors.light;

// Pick, list, remove. Uploading happens on send, not here -- a file uploaded
// the moment it is picked is a file orphaned the moment someone changes their
// mind, and this bucket has no lifecycle rule to clean those up.
export function AttachmentPicker({
  files,
  onChange,
}: {
  files: PendingAttachment[];
  onChange: (files: PendingAttachment[]) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const accept = (next: PendingAttachment) => {
    const check = checkAttachment(files, next);
    if (!check.ok) {
      setProblem(check.message);
      return;
    }
    setProblem(null);
    setWarning(check.warn);
    onChange([...files, next]);
  };

  const addImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    accept({
      uri: asset.uri,
      fileName: asset.fileName ?? 'screenshot.jpg',
      byteSize: asset.fileSize ?? 0,
      contentType: asset.mimeType ?? 'image/jpeg',
    });
  };

  const addDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    accept({
      uri: asset.uri,
      fileName: asset.name,
      byteSize: asset.size ?? 0,
      contentType: asset.mimeType ?? null,
    });
  };

  const remove = (index: number) => onChange(files.filter((_, i) => i !== index));

  return (
    <View>
      <View style={styles.actions}>
        <Pressable onPress={addImage} style={styles.action}>
          <Text style={styles.actionText}>Add a screenshot</Text>
        </Pressable>
        <Pressable onPress={addDocument} style={styles.action}>
          <Text style={styles.actionText}>Add a file</Text>
        </Pressable>
      </View>

      {files.map((file, index) => (
        <View key={`${file.uri}-${index}`} style={styles.row}>
          {file.contentType?.startsWith('image/') ? (
            <Image source={{ uri: file.uri }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={styles.thumb}>
              <Text style={styles.thumbGlyph}>📄</Text>
            </View>
          )}
          <View style={styles.rowText}>
            <Text style={styles.fileName} numberOfLines={1}>
              {file.fileName}
            </Text>
            <Text style={styles.fileSize}>{(file.byteSize / 1024 / 1024).toFixed(1)} MB</Text>
          </View>
          <Pressable onPress={() => remove(index)} hitSlop={8}>
            <Text style={styles.remove}>Remove</Text>
          </Pressable>
        </View>
      ))}

      <Text style={styles.hint}>
        {files.length} of {MAX_ATTACHMENTS} files. Screenshots, photos and PDFs.
      </Text>

      {warning && (
        <Caveat tone="context" onDismiss={() => setWarning(null)}>
          {warning}
        </Caveat>
      )}
      {problem && (
        <Caveat tone="wrong" action={{ label: 'OK', onPress: () => setProblem(null) }}>
          {problem}
        </Caveat>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8 },
  action: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 15,
  },
  actionText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 12,
    padding: 9,
    marginTop: 9,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 9,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbGlyph: { fontSize: 17 },
  rowText: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
  fileSize: { fontSize: 11, color: theme.bentoMuted2 },
  remove: { fontSize: 11.5, fontWeight: '800', color: theme.bentoMuted },
  hint: { fontSize: 11, color: theme.bentoMuted2, marginTop: 8 },
});
```

- [ ] **Step 2: Write the draft store**

The spec requires that nothing typed is ever lost to a failed send, including
across an app restart. Component state dies on unmount, so the draft is
persisted.

Create `src/lib/support-draft.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { isSupportCategory } from '@/lib/support-taxonomy';
import type { SupportDraft } from '@/lib/support';

const KEY = 'kaiibi.support.draft';

// Retyping a bug report is how people stop reporting bugs, so the draft
// outlives the sheet AND the app. Attachments are deliberately not persisted:
// a picked file's URI points at a cache entry that does not survive a restart,
// so storing it would restore a list of broken references rather than files.
//
// Web reads localStorage directly for the same reason locale-storage.ts does --
// it is synchronous, so the sheet opens already filled rather than filling in
// a tick later.
function readSync(): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function readStoredDraft(): Promise<SupportDraft | null> {
  let raw = readSync();
  if (raw === null && Platform.OS !== 'web') {
    try {
      raw = await AsyncStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Validated rather than trusted: this string was last written by a
    // possibly-older build, and a stale category would throw in categoryMeta().
    if (parsed.category !== null && !isSupportCategory(parsed.category)) return null;
    return {
      category: parsed.category ?? null,
      area: typeof parsed.area === 'string' ? parsed.area : null,
      areaOther: typeof parsed.areaOther === 'string' ? parsed.areaOther : '',
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      details: typeof parsed.details === 'string' ? parsed.details : '',
      contactPreference: ['in_app', 'whatsapp', 'email'].includes(parsed.contactPreference)
        ? parsed.contactPreference
        : 'in_app',
    };
  } catch {
    return null;
  }
}

// Fire-and-forget: a draft that fails to persist must never block typing.
export function writeStoredDraft(draft: SupportDraft): void {
  const raw = JSON.stringify(draft);
  if (Platform.OS === 'web') {
    try {
      window.localStorage.setItem(KEY, raw);
    } catch {
      /* private mode or storage disabled -- the draft just won't survive */
    }
    return;
  }
  void AsyncStorage.setItem(KEY, raw).catch(() => {});
}

export function clearStoredDraft(): void {
  if (Platform.OS === 'web') {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* nothing to do */
    }
    return;
  }
  void AsyncStorage.removeItem(KEY).catch(() => {});
}
```

- [ ] **Step 3: Write the form**

Create `src/components/support/support-compose.tsx`. It renders, in order: the identity strip, the category chips, the area dropdown, the free-text capture when `needsAreaOther`, subject, details, attachments, and the reply-preference row.

```tsx
import Constants from 'expo-constants';
import { usePathname } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AttachmentPicker } from '@/components/support/attachment-picker';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { isTabletDevice } from '@/lib/device';
import {
  attachmentPath,
  uploadAttachment,
  type PendingAttachment,
} from '@/lib/support-attachments';
import { buildClientContext, createThread, validateDraft, type ContactPreference, type SupportDraft } from '@/lib/support';
import { clearStoredDraft, readStoredDraft, writeStoredDraft } from '@/lib/support-draft';
import {
  categoryMeta,
  needsAreaOther,
  SUPPORT_CATEGORIES,
  type SupportCategory,
} from '@/lib/support-taxonomy';
import { personInitials, shortPersonName } from '@/lib/user-identity';
import { supabase } from '@/lib/supabase';

const theme = Colors.light;

const EMPTY_DRAFT: SupportDraft = {
  category: null,
  area: null,
  areaOther: '',
  subject: '',
  details: '',
  contactPreference: 'in_app',
};

export function SupportCompose({ onSent }: { onSent: (reference: string) => void }) {
  const { session, profile, shop, myMembership, activeLocation, entitlements } = useAuth();
  const pathname = usePathname();

  const [draft, setDraft] = useState<SupportDraft>(EMPTY_DRAFT);
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Restore once, then persist on every change. Nothing typed is lost to a
  // failed send, a closed sheet, or a killed app.
  useEffect(() => {
    void readStoredDraft().then((stored) => {
      if (stored) setDraft(stored);
    });
  }, []);

  useEffect(() => {
    writeStoredDraft(draft);
  }, [draft]);

  const meta = draft.category ? categoryMeta(draft.category) : null;
  const showAreaOther = draft.category ? needsAreaOther(draft.category, draft.area) : false;

  const email = session?.user?.email ?? null;
  const personName = profile?.fullName ?? myMembership?.fullName ?? null;
  const phone = profile?.phone ?? null;
  const role = profile?.role === 'admin' ? 'Owner' : (myMembership?.roleName ?? null);

  const context = useMemo(
    () =>
      buildClientContext({
        appVersion: Constants.expoConfig?.version ?? null,
        buildNumber:
          Platform.OS === 'ios'
            ? (Constants.expoConfig?.ios?.buildNumber ?? null)
            : (Constants.expoConfig?.android?.versionCode?.toString() ?? null),
        platform: Platform.OS,
        isTablet: isTabletDevice(),
        screen: pathname,
        locationName: activeLocation?.name ?? null,
      }),
    [pathname, activeLocation]
  );

  const pickCategory = (category: SupportCategory) => {
    // Clearing the area matters: the areas are per-category, so keeping 'pos'
    // after switching to Billing would store a key that category has never
    // heard of.
    setDraft((d) => ({ ...d, category, area: null, areaOther: '' }));
    setProblem(null);
  };

  const send = async () => {
    const validation = validateDraft(draft);
    if (!validation.ok) {
      setProblem(validation.message);
      return;
    }
    if (!shop || !session) return;

    setSending(true);
    setProblem(null);
    try {
      const thread = await createThread(shop.id, session.user.id, draft, context);
      const { data: message } = await supabase
        .from('support_messages')
        .select('id')
        .eq('thread_id', thread.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

      for (const file of files) {
        const path = attachmentPath(shop.id, thread.id, file.fileName, Date.now());
        await uploadAttachment(path, file);
        await supabase.from('support_attachments').insert({
          message_id: message?.id,
          storage_path: path,
          file_name: file.fileName,
          byte_size: file.byteSize,
          content_type: file.contentType,
        });
      }

      clearStoredDraft();
      setDraft(EMPTY_DRAFT);
      setFiles([]);
      onSent(thread.reference);
    } catch (error) {
      // The draft is deliberately left alone. Nothing typed is ever lost to a
      // failed send -- retyping a bug report is how people stop reporting bugs.
      setProblem(error instanceof Error ? error.message : 'That did not send. Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  const complete = validateDraft(draft).ok;

  return (
    <View>
      <Text style={styles.label}>Sent as</Text>
      <View style={styles.who}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{personInitials(personName, email)}</Text>
        </View>
        <View style={styles.whoText}>
          <Text style={styles.whoName}>
            {shortPersonName(personName, email)}
            {role ? ` · ${role}` : ''}
          </Text>
          <Text style={styles.whoLine}>
            {[shop?.name, entitlements.planName, activeLocation?.name].filter(Boolean).join(' · ')}
          </Text>
          <Text style={styles.whoLine}>{[email, phone].filter(Boolean).join(' · ')}</Text>
          <Text style={styles.auto}>
            Attached automatically: {Object.values(context).join(' · ')}
          </Text>
        </View>
      </View>

      <Text style={styles.label}>What&apos;s this about?</Text>
      <View style={styles.chips}>
        {SUPPORT_CATEGORIES.map((category) => {
          const on = draft.category === category.key;
          return (
            <Pressable
              key={category.key}
              onPress={() => pickCategory(category.key)}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                {category.glyph} {category.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {meta?.areaLabel && (
        <>
          <Text style={styles.label}>{meta.areaLabel}</Text>
          <View style={styles.chips}>
            {meta.areas.map((area) => {
              const on = draft.area === area.key;
              return (
                <Pressable
                  key={area.key}
                  onPress={() => setDraft((d) => ({ ...d, area: on ? null : area.key, areaOther: '' }))}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{area.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>Optional — it just helps us send this to the right place.</Text>
        </>
      )}

      {showAreaOther && (
        <View style={styles.reveal}>
          <Text style={styles.label}>Then what is it about?</Text>
          <TextInput
            value={draft.areaOther}
            onChangeText={(areaOther) => setDraft((d) => ({ ...d, areaOther }))}
            placeholder="A few words"
            placeholderTextColor={theme.bentoMuted2}
            style={styles.input}
          />
          <Text style={styles.hint}>This is how we find out what belongs on the list above.</Text>
        </View>
      )}

      {/* Billing is the category most likely to be about money already sent
          and not yet matched by hand, so the plan and its renewal date belong
          on screen before they describe the problem. */}
      {draft.category === 'billing' && (
        <Caveat tone="context">
          {`Your plan: ${entitlements.planName}. A ZAAD or eDahab payment is matched by hand, so if you've just paid, attach the confirmation SMS and we'll clear it faster.`}
        </Caveat>
      )}

      <Text style={styles.label}>Subject</Text>
      <TextInput
        value={draft.subject}
        onChangeText={(subject) => setDraft((d) => ({ ...d, subject }))}
        placeholder="A short line — &quot;Scanner stops after a refund&quot;"
        placeholderTextColor={theme.bentoMuted2}
        style={styles.input}
      />

      <Text style={styles.label}>{meta?.detailsLabel ?? 'Details'}</Text>
      <TextInput
        value={draft.details}
        onChangeText={(details) => setDraft((d) => ({ ...d, details }))}
        placeholder={meta ? '' : 'Pick a category above and we will tell you what is most useful to include.'}
        placeholderTextColor={theme.bentoMuted2}
        multiline
        style={[styles.input, styles.area]}
      />
      {meta && <Text style={styles.hint}>{meta.detailsHint}</Text>}

      <Text style={styles.label}>Attachments — optional</Text>
      <AttachmentPicker files={files} onChange={setFiles} />

      <Text style={styles.label}>Reply to me on</Text>
      <View style={styles.chips}>
        {(
          [
            { key: 'in_app', label: 'In the app', sub: 'here, under Your messages' },
            ...(phone ? [{ key: 'whatsapp' as const, label: 'WhatsApp', sub: phone }] : []),
            { key: 'email', label: 'Email', sub: email ?? '' },
          ] as { key: ContactPreference; label: string; sub: string }[]
        ).map((option) => {
          const on = draft.contactPreference === option.key;
          return (
            <Pressable
              key={option.key}
              onPress={() => setDraft((d) => ({ ...d, contactPreference: option.key }))}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.hint}>
        In the app always works and keeps the record. Picking WhatsApp doesn&apos;t change where the reply is
        written — it tells us to nudge you there too.
      </Text>

      {problem && (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => void send() }}>
          {problem}
        </Caveat>
      )}

      <Pressable
        onPress={send}
        disabled={!complete || sending}
        style={[styles.send, (!complete || sending) && styles.sendOff]}
      >
        <Text style={[styles.sendText, (!complete || sending) && styles.sendTextOff]}>
          {sending ? 'Sending…' : 'Send'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 18,
    marginBottom: 8,
  },
  who: { flexDirection: 'row', gap: 12, backgroundColor: theme.bentoSoft, borderRadius: 16, padding: 13 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.bentoAccentWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentInk },
  whoText: { flex: 1, minWidth: 0 },
  whoName: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  whoLine: { fontSize: 11.5, color: theme.bentoMuted },
  auto: {
    fontSize: 10.5,
    color: theme.bentoMuted2,
    marginTop: 9,
    paddingTop: 9,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 13,
  },
  chipOn: { backgroundColor: theme.bentoAccentWash, borderColor: 'transparent' },
  chipText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  chipTextOn: { color: theme.bentoAccentInk, fontWeight: '800' },
  reveal: { borderLeftWidth: 2, borderLeftColor: theme.bentoAccentWash, paddingLeft: 11 },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
    fontSize: 13.5,
    color: theme.bentoInk,
  },
  area: { minHeight: 96, textAlignVertical: 'top' },
  hint: { fontSize: 11, color: theme.bentoMuted2, marginTop: 6 },
  send: {
    marginTop: 20,
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingVertical: 13,
    alignItems: 'center',
  },
  sendOff: { backgroundColor: theme.bentoSoft },
  sendText: { fontSize: 13.5, fontWeight: '800', color: '#FFFFFF' },
  sendTextOff: { color: theme.bentoMuted2 },
});
```

- [ ] **Step 4: Confirm the auth fields this file reads actually exist**

Run:

```bash
grep -n "planName" src/lib/entitlements.ts
grep -n "phone" src/hooks/use-auth.tsx
grep -n "name" src/lib/location-selection.ts src/hooks/use-auth.tsx | grep -i location
```

Expected: `entitlements.planName`, `profile.phone` and `activeLocation.name` all resolve. If any does not, substitute the real field name — do not leave a property that does not exist, because TypeScript will fail the build and the identity strip will render blank.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `src/components/support/`.

- [ ] **Step 6: Commit**

```bash
git add src/components/support/attachment-picker.tsx src/components/support/support-compose.tsx src/lib/support-draft.ts
git commit -m "feat(support): compose form with captured identity, two-level taxonomy and a surviving draft"
```

---

### Task 7: The sheet — compose, list, thread

**Files:**
- Create: `src/components/support/support-thread-view.tsx`
- Create: `src/components/support/support-sheet.tsx`
- Modify: `src/components/admin-sidebar.tsx`, `src/components/admin-tabs.tsx`, `src/components/admin-tabs.web.tsx` (render the sheet)

**Interfaces:**
- Consumes: `SupportCompose` (Task 6), `listMyThreads`/`listMessages`/`postReply`/`markThreadRead` (Task 3), `signedUrlFor` (Task 4).
- Produces: `function SupportSheet({ visible, onClose }: { visible: boolean; onClose: () => void })`

- [ ] **Step 1: Write the thread view**

Create `src/components/support/support-thread-view.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { listMessages, markThreadRead, postReply, type SupportMessage, type SupportThread } from '@/lib/support';
import { signedUrlFor } from '@/lib/support-attachments';

const theme = Colors.light;

export function SupportThreadView({ thread, onBack }: { thread: SupportThread; onBack: () => void }) {
  const { session } = useAuth();
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [reply, setReply] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      setMessages(await listMessages(thread.id));
      // Marking read on open rather than on close: someone who reads a reply
      // and switches apps has still read it, and a badge that survives that is
      // a badge people learn to ignore.
      await markThreadRead(thread.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Could not load this conversation.');
    }
  }, [thread.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (!reply.trim() || !session) return;
    setSending(true);
    setProblem(null);
    try {
      await postReply(thread.id, reply, session.user.id);
      setReply('');
      await load();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not send.');
    } finally {
      setSending(false);
    }
  };

  const openAttachment = async (storagePath: string) => {
    try {
      await Linking.openURL(await signedUrlFor(storagePath));
    } catch {
      setProblem('Could not open that file.');
    }
  };

  return (
    <View>
      <Pressable onPress={onBack} hitSlop={8}>
        <Text style={styles.back}>‹ All messages</Text>
      </Pressable>
      <Text style={styles.subject}>{thread.subject}</Text>
      <Text style={styles.meta}>
        {thread.reference} · {thread.status === 'open' ? 'Open' : 'Closed'}
        {thread.openedBy === 'platform' ? ' · From Kaiibi' : ''}
      </Text>

      {messages === null ? (
        <ActivityIndicator style={styles.loading} />
      ) : (
        messages.map((message) => (
          <View
            key={message.id}
            style={[styles.bubble, message.authorKind === 'platform' ? styles.fromUs : styles.fromShop]}
          >
            <Text style={[styles.author, message.authorKind === 'platform' && styles.authorUs]}>
              {message.authorKind === 'platform' ? 'Kaiibi support' : 'You'}
            </Text>
            <Text style={[styles.body, message.authorKind === 'platform' && styles.bodyUs]}>{message.body}</Text>
            {message.attachments.map((attachment) => (
              <Pressable key={attachment.id} onPress={() => openAttachment(attachment.storagePath)}>
                <Text style={styles.attachment}>📎 {attachment.fileName}</Text>
              </Pressable>
            ))}
          </View>
        ))
      )}

      {thread.status === 'open' && (
        <>
          <Text style={styles.label}>Reply</Text>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Write back…"
            placeholderTextColor={theme.bentoMuted2}
            multiline
            style={styles.input}
          />
          <Pressable
            onPress={send}
            disabled={!reply.trim() || sending}
            style={[styles.send, (!reply.trim() || sending) && styles.sendOff]}
          >
            <Text style={[styles.sendText, (!reply.trim() || sending) && styles.sendTextOff]}>
              {sending ? 'Sending…' : 'Send reply'}
            </Text>
          </Pressable>
        </>
      )}

      {problem && (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => void load() }}>
          {problem}
        </Caveat>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  back: { fontSize: 12, fontWeight: '800', color: theme.bentoMuted, marginBottom: 10 },
  subject: { fontSize: 17, fontWeight: '800', letterSpacing: -0.3, color: theme.bentoInk },
  meta: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 3, marginBottom: 14 },
  loading: { marginVertical: 24 },
  bubble: { borderRadius: 16, padding: 13, marginBottom: 10 },
  fromShop: { backgroundColor: theme.bentoSoft },
  fromUs: { backgroundColor: theme.bentoAccentWash },
  author: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk },
  authorUs: { color: theme.bentoAccentInk },
  body: { fontSize: 13, color: theme.bentoInk2, marginTop: 4 },
  bodyUs: { color: theme.bentoAccentInk },
  attachment: { fontSize: 12, fontWeight: '700', color: theme.bentoAccentInk, marginTop: 8 },
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 12,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    padding: 12,
    minHeight: 80,
    fontSize: 13.5,
    color: theme.bentoInk,
    textAlignVertical: 'top',
  },
  send: { marginTop: 12, backgroundColor: theme.bentoInk, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  sendOff: { backgroundColor: theme.bentoSoft },
  sendText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  sendTextOff: { color: theme.bentoMuted2 },
});
```

- [ ] **Step 2: Write the sheet shell**

Create `src/components/support/support-sheet.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SupportCompose } from '@/components/support/support-compose';
import { SupportThreadView } from '@/components/support/support-thread-view';
import { AppModal } from '@/components/ui/app-modal';
import { BENTO_RADIUS, Colors } from '@/constants/theme';
import { listMyThreads, unreadCount, type SupportThread } from '@/lib/support';

const theme = Colors.light;

type View_ = { name: 'compose' } | { name: 'list' } | { name: 'thread'; thread: SupportThread } | { name: 'sent'; reference: string };

// One modal, three views, switched by local state rather than by routing.
// Support is something you reach for at the moment something breaks, from
// whatever screen you were on -- a route would take you off that screen and
// lose the context that makes the report useful.
export function SupportSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [view, setView] = useState<View_>({ name: 'compose' });
  const [threads, setThreads] = useState<SupportThread[]>([]);

  const load = useCallback(async () => {
    try {
      setThreads(await listMyThreads());
    } catch {
      setThreads([]);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void load().then(() => {
      // Opening straight into the list when something is waiting: a person who
      // opens this with an unread reply came to read it, not to write again.
      setThreads((current) => {
        setView(unreadCount(current) > 0 ? { name: 'list' } : { name: 'compose' });
        return current;
      });
    });
  }, [visible, load]);

  const close = () => {
    setView({ name: 'compose' });
    onClose();
  };

  return (
    <AppModal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.title}>
                {view.name === 'list' ? 'Your messages' : 'Help & support'}
              </Text>
              {view.name === 'compose' && (
                <Text style={styles.sub}>
                  Tell us what&apos;s going on. We read every message and usually reply the same working day.
                </Text>
              )}
            </View>
            <Pressable onPress={close} hitSlop={10}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {view.name === 'compose' && (
              <SupportCompose
                onSent={(reference) => {
                  void load();
                  setView({ name: 'sent', reference });
                }}
              />
            )}

            {view.name === 'sent' && (
              <View style={styles.done}>
                <View style={styles.tick}>
                  <Text style={styles.tickText}>✓</Text>
                </View>
                <Text style={styles.doneTitle}>Sent. We&apos;ve got it.</Text>
                <Text style={styles.doneSub}>
                  We&apos;ll answer here under Your messages, usually the same working day — you&apos;ll see a
                  mark on the ☰ when we do.
                </Text>
                <Text style={styles.reference}>{view.reference}</Text>
                <Pressable onPress={() => setView({ name: 'list' })} style={styles.doneButton}>
                  <Text style={styles.doneButtonText}>Your messages</Text>
                </Pressable>
              </View>
            )}

            {view.name === 'list' && (
              <View>
                {threads.length === 0 ? (
                  <Text style={styles.empty}>Nothing yet.</Text>
                ) : (
                  threads.map((thread) => {
                    const unread = !thread.shopReadAt || Date.parse(thread.lastMessageAt) > Date.parse(thread.shopReadAt);
                    return (
                      <Pressable key={thread.id} onPress={() => setView({ name: 'thread', thread })} style={styles.row}>
                        <View style={styles.rowText}>
                          <Text style={styles.rowSubject} numberOfLines={1}>
                            {thread.subject}
                          </Text>
                          <Text style={styles.rowMeta}>
                            {thread.reference}
                            {thread.openedBy === 'platform' ? ' · From Kaiibi' : ''}
                          </Text>
                        </View>
                        {unread && (
                          <View style={styles.unread}>
                            <Text style={styles.unreadText}>Unread</Text>
                          </View>
                        )}
                      </Pressable>
                    );
                  })
                )}
                <Pressable onPress={() => setView({ name: 'compose' })} style={styles.newButton}>
                  <Text style={styles.newButtonText}>New request</Text>
                </Pressable>
              </View>
            )}

            {view.name === 'thread' && (
              <SupportThreadView
                thread={view.thread}
                onBack={() => {
                  void load();
                  setView({ name: 'list' });
                }}
              />
            )}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 16 },
  sheet: {
    backgroundColor: theme.bentoSurface,
    borderRadius: BENTO_RADIUS,
    maxHeight: '90%',
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 19, fontWeight: '800', letterSpacing: -0.4, color: theme.bentoInk },
  sub: { fontSize: 12.5, color: theme.bentoMuted, marginTop: 3 },
  close: { fontSize: 15, color: theme.bentoMuted },
  body: { padding: 20, paddingBottom: 30 },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowSubject: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  rowMeta: { fontSize: 10.5, color: theme.bentoMuted2 },
  unread: { backgroundColor: theme.bentoAccentWash, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  unreadText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoAccentInk },
  newButton: {
    marginTop: 18,
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
  },
  newButtonText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
  done: { alignItems: 'center', paddingVertical: 26 },
  tick: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.bentoUpWash,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  tickText: { fontSize: 24, fontWeight: '800', color: theme.bentoUpInk },
  doneTitle: { fontSize: 18, fontWeight: '800', letterSpacing: -0.3, color: theme.bentoInk },
  doneSub: { fontSize: 12.5, color: theme.bentoMuted, textAlign: 'center', marginTop: 6, maxWidth: 320 },
  reference: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '700',
    color: theme.bentoInk2,
    backgroundColor: theme.bentoSoft,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  doneButton: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  doneButtonText: { fontSize: 12.5, fontWeight: '800', color: theme.bentoInk2 },
});
```

- [ ] **Step 3: Render the sheet from all three shells**

In each of `admin-sidebar.tsx`, `admin-tabs.tsx` and `admin-tabs.web.tsx`, import `SupportSheet` and render it as a sibling of the existing menu `AppModal`:

```tsx
<SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
```

- [ ] **Step 4: Verify end to end on web**

Run: `npm run web`

Walk through: ☰ → Help & support → pick **Something's broken** → confirm the area chips appear and the Details label reads "What happened?" → pick **Somewhere else** → confirm the free-text box appears and Send stays disabled until it is filled → fill subject and details → attach a screenshot → Send. Expected: the confirmation shows a `KB-####` reference. Then **Your messages** shows the thread, and opening it shows your message and the attachment.

- [ ] **Step 5: Lint, typecheck and commit**

```bash
npm run lint && npx tsc --noEmit
git add src/components/support/ src/components/admin-sidebar.tsx src/components/admin-tabs.tsx src/components/admin-tabs.web.tsx
git commit -m "feat(support): the sheet — compose, sent, list and thread"
```

---

### Task 8: A way out of the wall screens

`UpgradeScreen` and `NoAccessScreen` return *instead of* the `<Stack>`, so the shell — and the ☰ with it — never renders. The two most-stuck people currently have no route to us.

**Files:**
- Modify: `src/app/(admin)/_layout.tsx` (`NoAccessScreen` and `UpgradeScreen`)

- [ ] **Step 1: Add the button to both screens**

In `src/app/(admin)/_layout.tsx`, import:

```tsx
import { useState } from 'react';
import { SupportSheet } from '@/components/support/support-sheet';
```

In `NoAccessScreen`, add `const [supportOpen, setSupportOpen] = useState(false);` and render, above the existing Sign out pressable:

```tsx
{/* This screen is the one place a person can be completely stuck: their role
    grants nothing, so there is no shell, no ☰, and no other route out. */}
<Pressable onPress={() => setSupportOpen(true)}>
  <Text style={styles.noAccessSupport}>Contact support</Text>
</Pressable>
<SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
```

Do the same in `UpgradeScreen`. Add to the stylesheet:

```tsx
noAccessSupport: { fontSize: 13.5, fontWeight: '800', color: Colors.light.bentoAccentInk, marginBottom: 14 },
```

- [ ] **Step 2: Verify**

Sign in as a staff member whose role has no permissions (or temporarily empty a role in Settings → Roles). Expected: `NoAccessScreen` shows **Contact support**, and pressing it opens the sheet. Send a message and confirm it lands.

- [ ] **Step 3: Commit**

```bash
npm run lint && npx tsc --noEmit
git add "src/app/(admin)/_layout.tsx"
git commit -m "feat(support): reach support from the no-access and upgrade walls"
```

---

### Task 9: Edge function actions

**Files:**
- Modify: `supabase/functions/platform-admin/index.ts`

**Interfaces:**
- Produces: actions `open_support`, `reply_support`, `close_support`.

- [ ] **Step 1: Extend the action union and request body**

In the `type Action` union add:

```ts
  | 'open_support'
  | 'reply_support'
  | 'close_support'
```

In `type RequestBody` add:

```ts
  // Support. `reason` carries the message body for open_support and
  // reply_support -- see the note on those cases.
  support?: {
    threadId?: string;
    addressedUserId?: string | null;
    category?: string;
    subject?: string;
  };
```

- [ ] **Step 2: Add the three cases**

Insert before `case 'delete_shop':`:

```ts
      // The audit log's rule is that every action carries a reason (see the
      // guard near the top of this file). For support, the message body IS
      // the reason: asking an operator to justify each reply separately would
      // be absurd, and passing the body keeps the log recording what was
      // actually said rather than carving out an exemption.
      case 'open_support': {
        if (!body.shopId) return errorResponse(400, 'unknown', 'shopId is required.');
        const subject = body.support?.subject?.trim();
        const category = body.support?.category?.trim();
        if (!subject) return errorResponse(400, 'unknown', 'A subject is required.');
        if (!category) return errorResponse(400, 'unknown', 'A category is required.');

        const { data: thread, error: threadError } = await adminClient
          .from('support_threads')
          .insert({
            shop_id: body.shopId,
            opened_by: 'platform',
            author_user_id: null,
            addressed_user_id: body.support?.addressedUserId ?? null,
            category,
            subject,
          })
          .select('*')
          .single();
        if (threadError) throw new Error(threadError.message);

        const { error: messageError } = await adminClient.from('support_messages').insert({
          thread_id: thread.id,
          author_kind: 'platform',
          author_user_id: actorId,
          body: reason.trim(),
        });
        if (messageError) throw new Error(messageError.message);

        await audit('open_support', body.shopId, null, thread);
        return ok({ thread });
      }

      case 'reply_support': {
        const threadId = body.support?.threadId;
        if (!threadId) return errorResponse(400, 'unknown', 'threadId is required.');

        const { data: thread, error: loadError } = await adminClient
          .from('support_threads')
          .select('*')
          .eq('id', threadId)
          .maybeSingle();
        if (loadError) throw new Error(loadError.message);
        if (!thread) return errorResponse(404, 'unknown', 'No such conversation.');

        const { data: message, error: messageError } = await adminClient
          .from('support_messages')
          .insert({
            thread_id: threadId,
            author_kind: 'platform',
            author_user_id: actorId,
            body: reason.trim(),
          })
          .select('*')
          .single();
        if (messageError) throw new Error(messageError.message);

        await audit('reply_support', thread.shop_id, null, message);
        return ok({ message });
      }

      case 'close_support': {
        const threadId = body.support?.threadId;
        if (!threadId) return errorResponse(400, 'unknown', 'threadId is required.');

        const { data: before, error: beforeError } = await adminClient
          .from('support_threads')
          .select('*')
          .eq('id', threadId)
          .maybeSingle();
        if (beforeError) throw new Error(beforeError.message);
        if (!before) return errorResponse(404, 'unknown', 'No such conversation.');

        const { data: after, error: updateError } = await adminClient
          .from('support_threads')
          .update({ status: 'closed' })
          .eq('id', threadId)
          .select('*')
          .single();
        if (updateError) throw new Error(updateError.message);

        await audit('close_support', before.shop_id, before, after);
        return ok({ thread: after });
      }
```

- [ ] **Step 3: Deploy and smoke-test locally**

Run:

```bash
supabase functions serve platform-admin
```

In another shell, with an operator JWT in `$OPERATOR_JWT` and a shop id in `$SHOP_ID`:

```bash
curl -s -X POST http://127.0.0.1:54321/functions/v1/platform-admin \
  -H "Authorization: Bearer $OPERATOR_JWT" -H 'Content-Type: application/json' \
  -d "{\"action\":\"open_support\",\"reason\":\"Your ZAAD payment cleared — Growth renews 2 Oct.\",\"shopId\":\"$SHOP_ID\",\"support\":{\"category\":\"billing\",\"subject\":\"Your ZAAD payment cleared\"}}"
```

Expected: a JSON body containing a `thread` with a `KB-` reference. Then confirm the audit row:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select action, reason from platform_audit_log order by created_at desc limit 1;"
```

Expected: `open_support` with the message body as its reason.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/platform-admin/index.ts
git commit -m "feat(support): audited open, reply and close actions for operators"
```

---

### Task 10: Platform queries and the Support tab queue

**Files:**
- Modify: `src/lib/platform.ts`
- Create: `src/components/platform/support-tab.tsx`
- Modify: `src/app/platform/index.tsx`

**Interfaces:**
- Consumes: tables from Task 2, actions from Task 9.
- Produces:
  - `type PlatformSupportThread` — every field listed in the Step 3 code block, including `lastAuthorKind: 'shop' | 'platform'`, which `supportQueueState` reads.
  - `async function listSupportThreads(): Promise<PlatformSupportThread[]>`
  - `function supportQueueState(thread: PlatformSupportThread): 'needs_reply' | 'waiting_on_them' | 'unread_by_them' | 'closed'`
  - `function SupportTab({ threads, shops, onOpen, onCompose }: { threads: PlatformSupportThread[]; shops: PlatformShopRow[]; onOpen: (thread: PlatformSupportThread) => void; onCompose: () => void })`

- [ ] **Step 1: Write the failing test for the queue state**

Create `src/lib/__tests__/support-queue.test.ts`:

```ts
import { supportQueueState, type PlatformSupportThread } from '@/lib/platform';

function thread(over: Partial<PlatformSupportThread>): PlatformSupportThread {
  return {
    id: 't', reference: 'KB-1', shopId: 's', shopName: 'Shop', planName: 'Growth',
    subject: 'Subject', category: 'billing', area: null, areaOther: null,
    status: 'open', openedBy: 'shop', contactPreference: 'in_app', clientContext: {},
    lastMessageAt: '2026-08-09T12:00:00.000Z',
    platformReadAt: null, shopReadAt: null,
    authorName: 'Amina', authorPhone: null, messageCount: 1, attachmentCount: 0,
    lastAuthorKind: 'shop',
    ...over,
  };
}

describe('supportQueueState', () => {
  // Whose move it is, not how old it is. A one-operator queue sorted by age
  // buries the thing that has been answered under the thing that has not.
  it('is needs_reply when they wrote last', () => {
    expect(supportQueueState(thread({ lastAuthorKind: 'shop' }))).toBe('needs_reply');
  });

  it('is unread_by_them when we wrote last and nobody has opened it', () => {
    expect(
      supportQueueState(thread({ lastAuthorKind: 'platform', shopReadAt: null }))
    ).toBe('unread_by_them');
  });

  it('is waiting_on_them once they have read what we wrote', () => {
    expect(
      supportQueueState(
        thread({
          lastAuthorKind: 'platform',
          lastMessageAt: '2026-08-09T12:00:00.000Z',
          shopReadAt: '2026-08-09T12:30:00.000Z',
        })
      )
    ).toBe('waiting_on_them');
  });

  it('is closed regardless of who wrote last', () => {
    expect(supportQueueState(thread({ status: 'closed', lastAuthorKind: 'shop' }))).toBe('closed');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- support-queue`
Expected: FAIL — `supportQueueState` is not exported from `@/lib/platform`.

- [ ] **Step 3: Add the query and the state function to `src/lib/platform.ts`**

```ts
export type PlatformSupportThread = {
  id: string;
  reference: string;
  shopId: string;
  shopName: string;
  planName: string;
  subject: string;
  category: string;
  area: string | null;
  areaOther: string | null;
  status: 'open' | 'closed';
  openedBy: 'shop' | 'platform';
  contactPreference: 'in_app' | 'whatsapp' | 'email';
  clientContext: Record<string, string>;
  lastMessageAt: string;
  platformReadAt: string | null;
  shopReadAt: string | null;
  authorName: string | null;
  authorPhone: string | null;
  messageCount: number;
  attachmentCount: number;
  lastAuthorKind: 'shop' | 'platform';
};

// Four states, each naming WHOSE MOVE IT IS. Sorting a one-operator queue by
// age buries an answered thread under an unanswered one; sorting by this does
// not. 'unread_by_them' is the one that matters for a message we started --
// an outbound message nobody has opened is a message that never happened.
export function supportQueueState(
  thread: PlatformSupportThread
): 'needs_reply' | 'waiting_on_them' | 'unread_by_them' | 'closed' {
  if (thread.status === 'closed') return 'closed';
  if (thread.lastAuthorKind === 'shop') return 'needs_reply';
  if (!thread.shopReadAt || Date.parse(thread.shopReadAt) < Date.parse(thread.lastMessageAt)) {
    return 'unread_by_them';
  }
  return 'waiting_on_them';
}

export async function listSupportThreads(): Promise<PlatformSupportThread[]> {
  const { data, error } = await supabase
    .from('support_threads')
    .select(
      'id, reference, shop_id, subject, category, area, area_other, status, opened_by, contact_preference, client_context, last_message_at, platform_read_at, shop_read_at, shops(name), profiles:author_user_id(full_name, phone), support_messages(author_kind, created_at, support_attachments(id))'
    )
    .order('last_message_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row: any) => {
    const messages = (row.support_messages ?? []) as { author_kind: 'shop' | 'platform'; created_at: string; support_attachments: unknown[] }[];
    const sorted = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    return {
      id: row.id,
      reference: row.reference,
      shopId: row.shop_id,
      shopName: row.shops?.name ?? 'Unknown store',
      planName: '',
      subject: row.subject,
      category: row.category,
      area: row.area,
      areaOther: row.area_other,
      status: row.status,
      openedBy: row.opened_by,
      contactPreference: row.contact_preference,
      clientContext: row.client_context ?? {},
      lastMessageAt: row.last_message_at,
      platformReadAt: row.platform_read_at,
      shopReadAt: row.shop_read_at,
      authorName: row.profiles?.full_name ?? null,
      authorPhone: row.profiles?.phone ?? null,
      messageCount: sorted.length,
      attachmentCount: sorted.reduce((sum, m) => sum + (m.support_attachments?.length ?? 0), 0),
      lastAuthorKind: sorted[sorted.length - 1]?.author_kind ?? row.opened_by,
    };
  });
}
```

`planName` is filled in by the tab from the `shops` array it already has, rather than joined here — the subscription join is expensive and `listPlatformShops` has already done it.

- [ ] **Step 4: Add operator read policies for the joined tables**

The operator needs to read `profiles` for the author's name and phone. Confirm whether `is_platform_admin()` already grants that:

```bash
grep -rn "is_platform_admin" supabase/migrations | grep -i profile
```

If nothing matches, add to `supabase/migrations/20260825000000_support_threads.sql`:

```sql
-- Narrow on purpose: the operator answering a support thread needs the name
-- and number of the person who wrote it, and nothing else. verify-platform-portal
-- asserts operators still cannot read products, sales or customers -- keep it
-- that way.
create policy "operators read the profile of a support author"
  on public.profiles for select
  using (
    public.is_platform_admin()
    and exists (select 1 from public.support_threads t where t.author_user_id = profiles.id)
  );
```

Then run `supabase db reset` and re-run **both** `verify-support.sql` and `verify-platform-portal.sql`. The latter asserts the operator blast radius; it must still pass.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test -- support-queue`
Expected: PASS.

- [ ] **Step 6: Write the queue UI**

Create `src/components/platform/support-tab.tsx` with the KPI strip and the conversation list. Use `BentoCard` for both, `Chip` from `@/components/platform/kit` for the filters, and `Caveat tone="partial"` for the "past a day with no first reply" note.

```tsx
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Chip } from '@/components/platform/kit';
import { Colors } from '@/constants/theme';
import { supportQueueState, type PlatformShopRow, type PlatformSupportThread } from '@/lib/platform';
import { SUPPORT_CATEGORIES } from '@/lib/support-taxonomy';

const theme = Colors.light;

const STATE_LABEL: Record<ReturnType<typeof supportQueueState>, string> = {
  needs_reply: 'Needs a reply',
  waiting_on_them: 'Waiting on them',
  unread_by_them: 'Unread by them',
  closed: 'Closed',
};

export function SupportTab({
  threads,
  shops,
  onOpen,
  onCompose,
}: {
  threads: PlatformSupportThread[];
  shops: PlatformShopRow[];
  onOpen: (thread: PlatformSupportThread) => void;
  onCompose: () => void;
}) {
  const [filter, setFilter] = useState<string | null>(null);

  const open = threads.filter((t) => t.status === 'open');
  const stale = open.filter(
    (t) => supportQueueState(t) === 'needs_reply' && Date.now() - Date.parse(t.lastMessageAt) > 24 * 60 * 60 * 1000
  );
  const billing = open.filter((t) => t.category === 'billing');

  const shown = useMemo(
    () => (filter ? threads.filter((t) => t.category === filter) : threads),
    [threads, filter]
  );

  const planOf = (shopId: string) => shops.find((s) => s.id === shopId)?.planName ?? '—';

  return (
    <View>
      <BentoCard title="Support">
        <View style={styles.kpis}>
          <Kpi value={String(open.length)} label="Open" hint={`${stale.length} unanswered > 24h`} />
          <Kpi value={String(billing.length)} label="Billing" hint="money waiting on us" />
          <Kpi value={String(threads.length)} label="All time" hint="conversations" />
        </View>
      </BentoCard>

      <BentoCard
        title="Conversations"
        actions={
          <Pressable onPress={onCompose} style={styles.newButton}>
            <Text style={styles.newButtonText}>✉ New message</Text>
          </Pressable>
        }
      >
        <View style={styles.filters}>
          <Chip label={`All ${threads.length}`} active={filter === null} onPress={() => setFilter(null)} />
          {SUPPORT_CATEGORIES.map((category) => (
            <Chip
              key={category.key}
              label={`${category.shortLabel} ${threads.filter((t) => t.category === category.key).length}`}
              active={filter === category.key}
              onPress={() => setFilter(category.key)}
            />
          ))}
        </View>

        {shown.length === 0 ? (
          <Text style={styles.empty}>Nothing here.</Text>
        ) : (
          shown.map((thread) => {
            const state = supportQueueState(thread);
            return (
              <Pressable key={thread.id} onPress={() => onOpen(thread)} style={styles.row}>
                <View style={styles.rowText}>
                  <Text style={styles.subject} numberOfLines={1}>
                    {thread.subject}
                    {thread.openedBy === 'platform' ? '  (we started this)' : ''}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {[
                      thread.reference,
                      thread.shopName,
                      planOf(thread.shopId),
                      thread.authorName,
                      thread.attachmentCount ? `${thread.attachmentCount} attachments` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                {thread.contactPreference === 'whatsapp' && (
                  <View style={styles.waChip}>
                    <Text style={styles.waChipText}>Wants WhatsApp</Text>
                  </View>
                )}
                <View style={[styles.stateChip, state === 'needs_reply' && styles.stateUrgent]}>
                  <Text style={[styles.stateText, state === 'needs_reply' && styles.stateTextUrgent]}>
                    {STATE_LABEL[state]}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}

        {stale.length > 0 && (
          <Caveat tone="partial">
            {`${stale.length} ${stale.length === 1 ? 'conversation is' : 'conversations are'} past a day with no reply. A store waiting on a payment match is a store deciding whether to keep paying.`}
          </Caveat>
        )}
      </BentoCard>
    </View>
  );
}

function Kpi({ value, label, hint }: { value: string; label: string; hint: string }) {
  return (
    <View>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiHint}>{hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  kpis: { flexDirection: 'row', gap: 24, flexWrap: 'wrap' },
  kpiValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.6, color: theme.bentoInk },
  kpiLabel: { fontSize: 10.5, color: theme.bentoMuted },
  kpiHint: { fontSize: 10, color: theme.bentoMuted2 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  newButton: {
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  newButtonText: { fontSize: 11.5, fontWeight: '800', color: '#FFFFFF' },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  rowText: { flex: 1, minWidth: 0 },
  subject: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  meta: { fontSize: 10.5, color: theme.bentoMuted2 },
  waChip: { backgroundColor: theme.bentoUpWash, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  waChipText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoUpInk },
  stateChip: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  stateUrgent: { backgroundColor: theme.bentoDownWash },
  stateText: { fontSize: 10.5, fontWeight: '800', color: theme.bentoMuted2 },
  stateTextUrgent: { color: theme.bentoDownInk },
});
```

- [ ] **Step 7: Wire the tab into the console**

In `src/app/platform/index.tsx`:

1. Add `'support'` to the `Tab` union.
2. Add to `TABS`, between Requests and Plans:

```ts
  { key: 'support', label: 'Support', blurb: 'Every conversation with a store — what is broken, who is stuck, and anything we need to tell them.' },
```

3. Add `const [supportThreads, setSupportThreads] = useState<PlatformSupportThread[]>([]);` and load it alongside the other lists in the existing loader, using `listSupportThreads()`.
4. Render `<SupportTab … />` in the tab switch.

- [ ] **Step 8: Verify**

Run the app, sign in as an operator, open `/platform`, click **Support**. Expected: the thread sent in Task 7 appears with **Needs a reply**, its store name and reference. Clicking a category chip filters.

- [ ] **Step 9: Commit**

```bash
npm run lint && npx tsc --noEmit && npm test
git add src/lib/platform.ts src/lib/__tests__/support-queue.test.ts src/components/platform/support-tab.tsx src/app/platform/index.tsx supabase/migrations/20260825000000_support_threads.sql
git commit -m "feat(support): operator queue sorted by whose move it is"
```

---

### Task 11: The reply panel and the WhatsApp hand-off

**Files:**
- Modify: `src/components/platform/support-tab.tsx` (add the panel)

**Interfaces:**
- Consumes: `whatsAppLink` (Task 3), `callPlatformAdmin` (existing), `reply_support`/`close_support` (Task 9).

- [ ] **Step 1: Add the thread panel**

Add to `src/components/platform/support-tab.tsx` a `SupportThreadPanel` rendered in a `PlatformModal` when a thread is opened. Two columns above `TABLET_BREAKPOINT`, stacked below.

```tsx
function SupportThreadPanel({
  thread,
  shop,
  onDone,
  onClose,
}: {
  thread: PlatformSupportThread;
  shop: PlatformShopRow | undefined;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wide = width >= TABLET_BREAKPOINT;

  useEffect(() => {
    listMessages(thread.id).then(setMessages).catch(() => setMessages([]));
  }, [thread.id]);

  // The reply body is passed as `reason`. platform-admin requires one on every
  // action, and for support the body IS the justification -- see the comment on
  // the case in that function.
  const send = async (opts: { close?: boolean; whatsApp?: boolean }) => {
    if (!reply.trim()) {
      setError('Write something first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await callPlatformAdmin('reply_support', { support: { threadId: thread.id } }, reply.trim());
      if (opts.close) {
        await callPlatformAdmin('close_support', { support: { threadId: thread.id } }, reply.trim());
      }
      // Opened AFTER the reply is written, never instead of it: a failed
      // hand-off must not cost us the record of what we said.
      if (opts.whatsApp && thread.authorPhone) {
        const link = whatsAppLink(thread.authorPhone, reply.trim());
        if (link) await Linking.openURL(link);
      }
      setReply('');
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That reply did not go through.');
    } finally {
      setBusy(false);
    }
  };

  const openChat = async () => {
    if (!thread.authorPhone) return;
    const link = whatsAppLink(thread.authorPhone, '');
    if (link) await Linking.openURL(link);
  };

  return (
    <View style={[panelStyles.wrap, wide && panelStyles.wrapWide]}>
      <View style={panelStyles.main}>
        {messages === null ? (
          <ActivityIndicator />
        ) : (
          messages.map((message) => (
            <View
              key={message.id}
              style={[panelStyles.bubble, message.authorKind === 'platform' ? panelStyles.fromUs : panelStyles.fromShop]}
            >
              <Text style={panelStyles.author}>
                {message.authorKind === 'platform' ? 'Kaiibi support' : (thread.authorName ?? 'The store')}
              </Text>
              <Text style={panelStyles.body}>{message.body}</Text>
            </View>
          ))
        )}

        <Text style={panelStyles.label}>Your reply</Text>
        <TextInput value={reply} onChangeText={setReply} multiline style={panelStyles.input} />

        <View style={panelStyles.actions}>
          <PlatformButton label="Send & close" onPress={() => send({ close: true })} disabled={busy} />
          {thread.contactPreference === 'whatsapp' && thread.authorPhone && (
            <PlatformButton label="Send & open WhatsApp" onPress={() => send({ whatsApp: true })} disabled={busy} />
          )}
          <PlatformButton label="Send reply" onPress={() => send({})} disabled={busy} primary />
        </View>

        {thread.contactPreference === 'whatsapp' && (
          <Caveat tone="context">
            They asked to be nudged on WhatsApp too. Send writes the reply into the thread as always; Send &amp;
            open WhatsApp does that and then opens their chat with this reply already in the box. Kaiibi never
            sends the WhatsApp message itself — you do, from your own account.
          </Caveat>
        )}
        {error && <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => send({}) }}>{error}</Caveat>}
      </View>

      <View style={panelStyles.rail}>
        <Rail title="Who this is">
          <RailRow k="Store" v={thread.shopName} />
          <RailRow k="Person" v={thread.authorName ?? '—'} />
          {thread.authorPhone && (
            <RailRow k="WhatsApp" v={thread.authorPhone} action={{ label: 'Open chat', onPress: openChat }} />
          )}
        </Rail>
        <Rail title="Money">
          <RailRow k="Plan" v={shop?.planName ?? '—'} />
          <RailRow k="Status" v={shop?.status ?? '—'} />
        </Rail>
        <Rail title="Sent from">
          {Object.entries(thread.clientContext).map(([k, v]) => (
            <RailRow key={k} k={k} v={String(v)} />
          ))}
        </Rail>
      </View>
    </View>
  );
}
```

In the same file, add the rail pieces and styles:

```tsx
function Rail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={panelStyles.railCard}>
      <Text style={panelStyles.railTitle}>{title}</Text>
      {children}
    </View>
  );
}

function RailRow({
  k,
  v,
  action,
}: {
  k: string;
  v: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={panelStyles.railRow}>
      <Text style={panelStyles.railKey}>{k}</Text>
      <View style={panelStyles.railValueWrap}>
        <Text style={panelStyles.railValue}>{v}</Text>
        {action && (
          <Pressable onPress={action.onPress} style={panelStyles.railAction}>
            <Text style={panelStyles.railActionText}>{action.label}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const panelStyles = StyleSheet.create({
  wrap: { gap: 14 },
  wrapWide: { flexDirection: 'row' },
  // 1.55 : 1 -- the conversation is what you read, the rail is what you glance at.
  main: { flex: 1.55, minWidth: 0 },
  rail: { flex: 1, minWidth: 0, gap: 12 },
  bubble: { borderRadius: 16, padding: 13, marginBottom: 10 },
  fromShop: { backgroundColor: theme.bentoSoft },
  fromUs: { backgroundColor: theme.bentoAccentWash },
  author: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk },
  body: { fontSize: 12.5, color: theme.bentoInk2, marginTop: 4 },
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 14,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    padding: 12,
    minHeight: 90,
    fontSize: 13.5,
    color: theme.bentoInk,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  railCard: { backgroundColor: theme.bentoSoft, borderRadius: 16, padding: 14 },
  railTitle: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginBottom: 9,
  },
  railRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  railKey: { fontSize: 12, color: theme.bentoMuted },
  railValueWrap: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 },
  railValue: { fontSize: 12, fontWeight: '700', color: theme.bentoInk, textAlign: 'right' },
  railAction: {
    borderWidth: 1,
    borderColor: theme.bentoUpInk,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  railActionText: { fontSize: 11, fontWeight: '800', color: theme.bentoUpInk },
});
```

The first `railRow` in each card draws a top rule it does not need; that is
deliberate — every card's rows then rule identically, rather than the first one
being a special case in three places.

Before using `PlatformButton` with `primary` and `disabled`, read its real
signature at `src/components/platform/kit.tsx:22` and substitute the actual
prop names. Do not assume these two exist.

- [ ] **Step 2: Verify the round trip**

Open the thread from Task 7 in the console, type a reply, press **Send reply**. Expected: the reply appears in the thread; back in the store's app, ☰ shows a badge and the thread shows the reply.

Then set that thread's `contact_preference` to `whatsapp` in the database, reopen it, and confirm **Send & open WhatsApp** appears and opens a `wa.me` URL with the reply pre-filled.

- [ ] **Step 3: Confirm the audit row**

Run:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select action, left(reason, 40) from platform_audit_log order by created_at desc limit 3;"
```

Expected: a `reply_support` row whose reason is the reply text.

- [ ] **Step 4: Commit**

```bash
npm run lint && npx tsc --noEmit
git add src/components/platform/support-tab.tsx
git commit -m "feat(support): operator reply panel with context rail and WhatsApp hand-off"
```

---

### Task 12: Starting a conversation from the console

**Files:**
- Modify: `src/components/platform/support-tab.tsx` (compose modal)
- Modify: `src/components/platform/shop-drawer.tsx` (Message this store)

- [ ] **Step 1: Add the outbound composer**

Add to `src/components/platform/support-tab.tsx`:

```tsx
export function SupportComposeModal({
  shops,
  initialShopId,
  onDone,
  onClose,
}: {
  shops: PlatformShopRow[];
  initialShopId: string | null;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [shopId, setShopId] = useState<string | null>(initialShopId);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<OperatorCategory>('billing');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return shops.filter((shop) => shop.name.toLowerCase().includes(q)).slice(0, 6);
  }, [shops, search]);

  const chosen = shops.find((shop) => shop.id === shopId) ?? null;

  const send = async () => {
    if (!shopId) {
      setError('Pick a store first.');
      return;
    }
    if (!subject.trim() || !message.trim()) {
      setError('A subject and a message are both needed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The message body is passed as `reason` -- platform-admin requires one
      // on every action, and for support the body IS the justification.
      //
      // addressedUserId stays null: that means "the store", which the policy
      // in migration 20260825000000 reads as settings.access holders. Sending
      // to one named person is a later addition, and needs a member picker
      // this version does not have.
      await callPlatformAdmin(
        'open_support',
        { shopId, support: { category, subject: subject.trim(), addressedUserId: null } },
        message.trim()
      );
      await onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That message did not send.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={composeStyles.label}>To</Text>
      {chosen ? (
        <Pressable onPress={() => setShopId(null)} style={composeStyles.token}>
          <Text style={composeStyles.tokenText}>{chosen.name}  ✕</Text>
        </Pressable>
      ) : (
        <>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search stores…"
            placeholderTextColor={theme.bentoMuted2}
            style={composeStyles.input}
          />
          {matches.map((shop) => (
            <Pressable
              key={shop.id}
              onPress={() => {
                setShopId(shop.id);
                setSearch('');
              }}
              style={composeStyles.match}
            >
              <Text style={composeStyles.matchText}>{shop.name}</Text>
            </Pressable>
          ))}
        </>
      )}

      <Text style={composeStyles.label}>What&apos;s this about?</Text>
      <View style={composeStyles.chips}>
        {OPERATOR_CATEGORIES.map((option) => (
          <Chip
            key={option.key}
            label={`${option.glyph} ${option.label}`}
            active={category === option.key}
            onPress={() => setCategory(option.key)}
          />
        ))}
      </View>

      <Text style={composeStyles.label}>Subject</Text>
      <TextInput value={subject} onChangeText={setSubject} style={composeStyles.input} />

      <Text style={composeStyles.label}>Message</Text>
      <TextInput
        value={message}
        onChangeText={setMessage}
        multiline
        style={[composeStyles.input, composeStyles.area]}
      />

      {error && <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => void send() }}>{error}</Caveat>}

      <View style={composeStyles.actions}>
        <PlatformButton label="Cancel" onPress={onClose} />
        <PlatformButton label={busy ? 'Sending…' : 'Send'} onPress={send} disabled={busy} primary />
      </View>
    </View>
  );
}

const composeStyles = StyleSheet.create({
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 16,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    padding: 11,
    fontSize: 13.5,
    color: theme.bentoInk,
  },
  area: { minHeight: 110, textAlignVertical: 'top' },
  match: { paddingVertical: 9, borderTopWidth: 1, borderTopColor: theme.bentoRule },
  matchText: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  token: {
    alignSelf: 'flex-start',
    backgroundColor: theme.bentoAccentWash,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  tokenText: { fontSize: 12, fontWeight: '800', color: theme.bentoAccentInk },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 18, justifyContent: 'flex-end' },
});
```

Render it inside a `PlatformModal`, driven from `src/app/platform/index.tsx` so
both entry points (the tab's **New message** button and the drawer's shortcut)
share one instance.

**One store at a time.** Do not add multi-store selection or a plan filter —
"message every store on Starter" is a broadcast, which has different failure
modes and needs a reply-disabled thread type. See the spec's §2.3.

- [ ] **Step 2: Add the drawer shortcut**

In `src/components/platform/shop-drawer.tsx`, add a **Message this store** button that closes the drawer and opens the composer with that shop pre-selected. Lift the composer's `visible` and `shopId` state to `src/app/platform/index.tsx` so both entry points drive the same modal.

- [ ] **Step 3: Verify both directions**

From the console, send a new message to a shop addressed to the store. In the shop's app as the **owner**, expect the message under Your messages with a *From Kaiibi* mark and a working reply box. As a **cashier** in the same shop, expect not to see it at all — that is the policy from Task 2 doing its job.

- [ ] **Step 4: Commit**

```bash
npm run lint && npx tsc --noEmit
git add src/components/platform/support-tab.tsx src/components/platform/shop-drawer.tsx src/app/platform/index.tsx
git commit -m "feat(support): operators can start a conversation with a store"
```

---

### Task 13: Live unread count

**Files:**
- Modify: `src/components/support/support-menu-item.tsx`

- [ ] **Step 1: Subscribe to new messages**

Add to `useSupportUnread`, after the existing `useEffect`:

```tsx
  useEffect(() => {
    if (!session) return;
    // Best-effort by design. A tablet living on the POS all day sees a message
    // arrive; a phone in a pocket does not. Real push needs the delivery
    // infrastructure docs/backlog/2026-08-01-notification-delivery.md records
    // as not existing yet, and anything genuinely urgent still goes out over
    // WhatsApp by hand.
    const channel = supabase
      .channel('support-unread')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages' }, () => {
        void refresh();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session, refresh]);
```

Import `supabase` from `@/lib/supabase`.

- [ ] **Step 2: Enable realtime on the table**

Append to `supabase/migrations/20260825000000_support_threads.sql`:

```sql
-- Realtime respects RLS, so a subscriber is only told about a message on a
-- thread they could already read.
alter publication supabase_realtime add table public.support_messages;
```

Re-run `supabase db reset` and `psql … -f supabase/tests/verify-support.sql`.

- [ ] **Step 3: Add the banner**

A small number on a menu nobody opened is not a delivery mechanism. The spec
asks for one line on the next app open as well, so an unread message is not
represented solely by a badge someone has to notice.

Create `src/components/support/support-banner.tsx`:

```tsx
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useSupportUnread } from '@/components/support/support-menu-item';

const theme = Colors.light;

// Shown once per app open, not once per navigation: dismissing it must stick
// for the session or it becomes the thing people learn to swipe away without
// reading, which is worse than no banner at all.
export function SupportBanner({ onOpen }: { onOpen: () => void }) {
  const { count } = useSupportUnread();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || count === 0) return null;

  return (
    <View style={styles.bar}>
      <Text style={styles.text}>
        {count === 1 ? 'You have a message from Kaiibi.' : `You have ${count} messages from Kaiibi.`}
      </Text>
      <Pressable onPress={onOpen} hitSlop={8}>
        <Text style={styles.action}>Read</Text>
      </Pressable>
      <Pressable onPress={() => setDismissed(true)} hitSlop={8}>
        <Text style={styles.close}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.bentoAccentWash,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  text: { flex: 1, fontSize: 12.5, fontWeight: '700', color: theme.bentoAccentInk },
  action: { fontSize: 12.5, fontWeight: '800', color: theme.bentoAccentInk },
  close: { fontSize: 13, color: theme.bentoAccentInk, opacity: 0.7 },
});
```

Render it in all three shells directly under the top bar, passing
`onOpen={() => setSupportOpen(true)}` — the same state the ☰ row already
drives.

- [ ] **Step 4: Verify**

With the store's app open in one browser and the console in another, send a reply from the console. Expected: the badge on the store's ☰ appears within a second or two without a reload, and the banner appears above the content. Pressing **Read** opens the sheet on the list view; pressing ✕ hides it for the session.

- [ ] **Step 5: Commit**

```bash
npm run lint && npx tsc --noEmit
git add src/components/support/support-menu-item.tsx src/components/support/support-banner.tsx src/components/admin-sidebar.tsx src/components/admin-tabs.tsx src/components/admin-tabs.web.tsx supabase/migrations/20260825000000_support_threads.sql
git commit -m "feat(support): live unread count over realtime, plus a banner on open"
```

---

### Task 14: Verify on device

Native layout is verified in a simulator, not by reading code — a stale bundle fakes failures and code reading misses them.

- [ ] **Step 1: Run the full automated suite**

```bash
npm test
npm run lint
npx tsc --noEmit
supabase db reset
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-support.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-platform-portal.sql
```

Expected: all green; both SQL scripts print `ALL CHECKS PASSED`.

- [ ] **Step 2: Android**

Run: `npm run android`

Check, taking a screenshot of each: the ☰ row is present and reachable; the sheet's category chips wrap to two rows without clipping; the details field grows and the keyboard does not cover the Send button; the attachment picker opens and a picked image shows a thumbnail; the confirmation shows the reference.

- [ ] **Step 3: iOS**

Run: `npm run ios`

Same checks. Pay attention to the modal in landscape on an iPad — `AppModal` supplies `supportedOrientations`, so it must not force a rotation.

- [ ] **Step 4: Fix anything the screenshots show, then commit**

```bash
git add -A
git commit -m "fix(support): device layout corrections from simulator verification"
```

- [ ] **Step 5: Update the taxonomy note in the docs**

Append to `docs/superpowers/specs/2026-08-09-help-and-support-design.md` under §8 a line recording anything that changed during implementation, so the spec and the code do not disagree.

```bash
git add docs/superpowers/specs/2026-08-09-help-and-support-design.md
git commit -m "docs(spec): record what changed during implementation"
```
