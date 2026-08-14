# Platform Store People & Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator console the people behind each store — owner name, email, phone with a one-tap WhatsApp button, the whole team with per-branch access, and every branch with its city — all read-only.

**Architecture:** One `security definer` SQL function (`platform_shop_people`) returns a narrow, fixed column list from `shop_members` × `roles` × `shop_member_locations`, because the table-wide select grant means a row-scoped policy would also hand back `pay_rate_cents`. Branch rows need no migration at all — operators already have a select policy on every `shop_locations` row and `listPlatformShops` merely filters them out. All decision logic (labels, sorting, search matching) lives in a new pure module `src/lib/shop-people.ts` with its own unit tests, following the `src/lib/attention.ts` pattern; components stay thin.

**Tech Stack:** Expo SDK 57 / React Native, TypeScript, Supabase (Postgres + RLS), Jest with `jest-expo` and `react-test-renderer`.

**Design source:** `docs/design/store-people-contacts-mockup.html` (section 3 is a working click-through of the drawer's two views).

## Global Constraints

- **Expo has changed.** Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code (`AGENTS.md`).
- **Read-only, everywhere.** No operator write path to `shop_members`, `roles`, `shop_member_locations` or `shop_locations`. No new action in the `platform-admin` edge function. This plan adds exactly one function and it is `stable`, not `volatile`.
- **Never return pay.** `shop_members` carries `pay_type`, `pay_rate_cents`, `hire_date`, `photo_url`. None appear in the function's `returns table` list. Not filtered client-side — absent from the signature.
- **An empty branch-assignment array means EVERY branch, not none.** `can_access_location()` (`supabase/migrations/20260814000000_staff_multi_store.sql:96`) grants a member with no rows in `shop_member_locations` access to all branches. Any label computed the other way states the opposite of what the database enforces.
- **The portal is pinned to the light palette.** Every new component starts with `const theme = Colors.light;` — no dark-mode switching in `src/app/platform/` or `src/components/platform/`.
- **Colours come from `Colors.light` tokens only.** Never write a hex literal into a screen (see the `building-bento-screens` skill). The one exception this plan introduces is the WhatsApp brand green, which is defined once as a named constant in Task 4 and imported everywhere else.
- **Migration filename must be `20260829000000_platform_shop_people.sql`.** This worktree is branched from `origin/main`, which does not yet contain `20260828000000_campaigns.sql` from the `marketing-phase3-campaigns` branch. Using `20260828…` would collide on merge.
- **Never edit an existing migration.** Every file in `supabase/migrations/` is applied to the remote project; changing one leaves the deployed database and this repository describing different schemas.
- **Commit after every task.** Do not push. This worktree is on branch `worktree-platform-store-people`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260829000000_platform_shop_people.sql` | **Create.** The one narrow read function. |
| `supabase/tests/verify-platform-shop-people.sql` | **Create.** Security assertions: non-operator blocked, aal1 blocked, pay columns unreachable. |
| `src/lib/shop-people.ts` | **Create.** Types + pure decisions: branch-access label, people sorting, team summary line, search matching. No I/O. |
| `src/lib/__tests__/shop-people.test.ts` | **Create.** Unit tests for the above. |
| `src/lib/platform.ts` | **Modify.** Add `listShopPeople()`; widen the `shop_locations` read; add `owner`, `branches`, `people` to `PlatformShopRow`. |
| `src/lib/__tests__/platform-shop-people.test.ts` | **Create.** Mapping tests against a stubbed supabase client. |
| `src/components/platform/whatsapp-button.tsx` | **Create.** The glyph button + the mail glyph. Hides itself when a number is undialable. |
| `src/components/platform/__tests__/whatsapp-button.test.tsx` | **Create.** Renders/hides, opens the right URL. |
| `src/components/platform/people-list.tsx` | **Create.** The person row, the branch row, and the two grouped lists. Shared by the drawer and the team view. |
| `src/components/platform/shop-drawer.tsx` | **Modify.** People + Where they trade sections; the team view; drop Staff/Branches from Usage. |
| `src/components/platform/__tests__/shop-drawer-people.test.tsx` | **Create.** The two-view swap and what each row shows. |
| `src/components/platform/shops-tab.tsx` | **Modify.** Owner + city in the Store cell, Contact column, widened search. |
| `src/components/platform/__tests__/shops-tab-contacts.test.tsx` | **Create.** Column content and search behaviour. |
| `src/components/platform-overview.tsx` | **Modify.** Attention rows name the owner and use the glyph. |
| `src/app/platform/index.tsx` | **Modify.** Load people in the existing batch; fail independently. |

---

### Task 1: The read function and its security proof

**Files:**
- Create: `supabase/migrations/20260829000000_platform_shop_people.sql`
- Create: `supabase/tests/verify-platform-shop-people.sql`

**Interfaces:**
- Consumes: `public.is_platform_admin()` (`20260818000500`), `public.shop_members`, `public.roles`, `public.shops`, `public.shop_member_locations`, `public.shop_locations`.
- Produces: `public.platform_shop_people(p_shop_ids uuid[])` returning `(shop_id uuid, user_id uuid, full_name text, email text, phone text, role_name text, role_permissions text[], is_owner boolean, active boolean, joined_at timestamptz, branch_names text[])`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260829000000_platform_shop_people.sql`:

```sql
-- Who works at a store, for the operator console.
--
-- A security-definer function rather than a select policy on shop_members, for
-- exactly the reason 20260825000400 replaced the profiles policy it had just
-- added: 0003_grants gives `authenticated` table-wide select on shop_members,
-- so a policy naming no columns hands back every column the table has -- which
-- since 20260802030200 includes pay_type, pay_rate_cents and hire_date. A
-- policy would make an operator's own API access wider than the app's query
-- string, and what an operator is bounded by is the policy, not the query.
--
-- Kaiibi operators have no business knowing what a shop pays its cashier. The
-- only way to guarantee that is to never select it.
--
-- Read-only by construction: `stable`, no write path anywhere, and the
-- platform-admin edge function gains no action that touches these tables. An
-- operator can see a store's roster and cannot change one row of it.

create or replace function public.platform_shop_people(p_shop_ids uuid[])
returns table (
  shop_id          uuid,
  user_id          uuid,
  full_name        text,
  email            text,
  phone            text,
  role_name        text,
  role_permissions text[],
  is_owner         boolean,
  active           boolean,
  joined_at        timestamptz,
  branch_names     text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.shop_id,
    m.user_id,
    m.full_name,
    m.email,
    m.phone,
    r.name,
    r.permissions,
    (s.owner_id = m.user_id),
    m.active,
    m.created_at,
    -- An EMPTY array means every branch, not none. can_access_location()
    -- (20260814000000) treats a member with no assignment rows as reaching all
    -- of them, so the caller labels this off the array's length -- and getting
    -- that backwards would tell an operator the opposite of what the database
    -- enforces. Primary branch first, so "Main" leads the list it is in.
    coalesce(
      (select array_agg(l.name order by l.is_primary desc, l.name)
         from public.shop_member_locations ml
         join public.shop_locations l on l.id = ml.location_id
        where ml.shop_member_id = m.id),
      '{}'::text[]
    )
  from public.shop_members m
  join public.roles r on r.id = m.role_id
  join public.shops s on s.id = m.shop_id
  where public.is_platform_admin()
    and m.shop_id = any(p_shop_ids);
$$;

-- Postgres grants execute to PUBLIC on every new function, which on a definer
-- function means anon too. Revoked before the one explicit grant, so the grant
-- is the whole list of who can call it.
revoke execute on function public.platform_shop_people(uuid[]) from public;
grant execute on function public.platform_shop_people(uuid[]) to authenticated;
```

- [ ] **Step 2: Write the verification script**

Create `supabase/tests/verify-platform-shop-people.sql`, following the shape of `supabase/tests/verify-platform-portal.sql`:

```sql
-- Security verification for platform_shop_people() (migration
-- 20260829000000). One DO block, rolled back by its own exception clause, so
-- it leaves no rows behind.
--
-- Written as "the attacker got this far, and then could not", because that is
-- the question an operator-account compromise actually asks.

\set ON_ERROR_STOP on

do $$
declare
  v_operator uuid := gen_random_uuid();
  v_owner    uuid := gen_random_uuid();
  v_staff    uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_shop_id  uuid;
  v_loc_main uuid;
  v_loc_two  uuid;
  v_member   uuid;
  v_count    integer;
  v_names    text[];
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at) values
    (v_operator, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'op-'   || v_operator || '@example.test', '', now(), now(), now()),
    (v_owner,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'own-'  || v_owner    || '@example.test', '', now(), now(), now()),
    (v_staff,    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'staff-'|| v_staff    || '@example.test', '', now(), now(), now()),
    (v_outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'out-'  || v_outsider || '@example.test', '', now(), now(), now());

  insert into public.shops (owner_id, name) values (v_owner, 'People Verify Shop') returning id into v_shop_id;
  insert into public.shop_locations (shop_id, name, city, is_primary)
    values (v_shop_id, 'Main', 'Hargeisa', true) returning id into v_loc_main;
  insert into public.shop_locations (shop_id, name, city, is_primary)
    values (v_shop_id, 'Koodbuur', 'Hargeisa', false) returning id into v_loc_two;

  insert into public.platform_admins (user_id, role, note) values (v_operator, 'owner', 'verify');

  -- A cashier tied to ONE branch, with pay recorded. The pay is the thing the
  -- function must never hand back.
  insert into public.shop_members (shop_id, user_id, role_id, active, full_name, email, phone, pay_type, pay_rate_cents)
    values (
      v_shop_id, v_staff,
      (select id from public.roles where shop_id = v_shop_id and name = 'Cashier'),
      true, 'Sahra Ismaaciil', 'sahra@example.test', '0634418820', 'monthly', 25000
    )
    returning id into v_member;
  insert into public.shop_member_locations (shop_member_id, location_id) values (v_member, v_loc_two);

  -- 1. A signed-in nobody gets nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_outsider, 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_count from public.platform_shop_people(array[v_shop_id]);
  if v_count <> 0 then
    raise exception 'FAIL: a non-operator read % roster rows', v_count;
  end if;

  -- 2. An operator WITHOUT a second factor gets nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', v_operator, 'aal', 'aal1')::text, true);
  select count(*) into v_count from public.platform_shop_people(array[v_shop_id]);
  if v_count <> 0 then
    raise exception 'FAIL: an operator at aal1 read % roster rows', v_count;
  end if;

  -- 3. An operator WITH aal2 sees the owner and the cashier, and nothing else.
  perform set_config('request.jwt.claims', json_build_object('sub', v_operator, 'aal', 'aal2')::text, true);
  select count(*) into v_count from public.platform_shop_people(array[v_shop_id]);
  if v_count <> 2 then
    raise exception 'FAIL: operator saw % roster rows, expected 2 (owner + cashier)', v_count;
  end if;

  -- 4. The owner's row is flagged, and carries an EMPTY branch array -- their
  --    access comes from owns_shop(), never from an assignment row.
  select branch_names into v_names from public.platform_shop_people(array[v_shop_id]) where is_owner;
  if v_names <> '{}'::text[] then
    raise exception 'FAIL: owner carried branch assignments %, expected empty', v_names;
  end if;

  -- 5. The assigned cashier names exactly their one branch.
  select branch_names into v_names from public.platform_shop_people(array[v_shop_id]) where not is_owner;
  if v_names <> array['Koodbuur'] then
    raise exception 'FAIL: cashier branches were %, expected {Koodbuur}', v_names;
  end if;

  -- 6. Pay is not reachable through this function at all. The column list is
  --    fixed, so asking for it is an error rather than a value -- which is the
  --    property being asserted.
  begin
    perform pay_rate_cents from public.platform_shop_people(array[v_shop_id]);
    raise exception 'FAIL: pay_rate_cents was reachable through platform_shop_people()';
  exception when undefined_column then
    null; -- expected
  end;

  perform set_config('role', 'postgres', true);
  raise exception 'ROLLBACK: verification passed';
exception
  when others then
    if sqlerrm = 'ROLLBACK: verification passed' then
      raise notice 'verify-platform-shop-people: all assertions passed';
    else
      raise;
    end if;
end $$;
```

- [ ] **Step 3: Run the verification against a local database**

Run: `supabase db reset && psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -f supabase/tests/verify-platform-shop-people.sql`

Expected: `NOTICE:  verify-platform-shop-people: all assertions passed`

If the local Supabase stack is not running, start it with `supabase start` first. If Docker is unavailable in this environment, stop and report that Task 1 could not be verified locally — do **not** mark it done and do not proceed to Task 2 claiming it passed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260829000000_platform_shop_people.sql supabase/tests/verify-platform-shop-people.sql
git commit -m "feat(platform): let operators read a store's roster, and nothing it pays them"
```

---

### Task 2: The pure decisions

**Files:**
- Create: `src/lib/shop-people.ts`
- Test: `src/lib/__tests__/shop-people.test.ts`

**Interfaces:**
- Consumes: nothing. This module imports no I/O and no React.
- Produces:
  - `type ShopPerson = { userId: string; shopId: string; name: string; email: string | null; phone: string | null; roleName: string; permissions: string[]; isOwner: boolean; active: boolean; joinedAt: string; branchNames: string[] }`
  - `type Branch = { id: string; name: string; city: string | null; neighborhood: string | null; phone: string | null; isPrimary: boolean }`
  - `branchAccessLabel(person: ShopPerson, branchCount: number): string`
  - `sortPeople(people: ShopPerson[]): ShopPerson[]`
  - `teamSummary(people: ShopPerson[]): string | null`
  - `contactPhone(person: ShopPerson | null, branches: Branch[]): string | null`
  - `personMatchesQuery(person: ShopPerson, query: string): boolean`
  - `cityLabel(branches: Branch[]): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/shop-people.test.ts`:

```ts
import {
  branchAccessLabel,
  cityLabel,
  contactPhone,
  personMatchesQuery,
  sortPeople,
  teamSummary,
  type Branch,
  type ShopPerson,
} from '@/lib/shop-people';

function person(over: Partial<ShopPerson> & { userId: string }): ShopPerson {
  return {
    shopId: 'shop-1',
    name: 'Somebody',
    email: 'somebody@example.test',
    phone: null,
    roleName: 'Cashier',
    permissions: [],
    isOwner: false,
    active: true,
    joinedAt: '2026-08-03T09:00:00Z',
    branchNames: [],
    ...over,
  };
}

function branch(over: Partial<Branch> & { id: string }): Branch {
  return {
    name: 'Main',
    city: 'Hargeisa',
    neighborhood: null,
    phone: null,
    isPrimary: false,
    ...over,
  };
}

describe('branchAccessLabel', () => {
  // The rule can_access_location() enforces: no assignment rows means EVERY
  // branch. Rendering that as "no branches" would state the opposite.
  it('reads an empty assignment list as every branch', () => {
    expect(branchAccessLabel(person({ userId: 'u1' }), 2)).toBe('Both branches');
  });

  it('says "All branches" once there are more than two', () => {
    expect(branchAccessLabel(person({ userId: 'u1' }), 3)).toBe('All branches');
  });

  // A single-branch store has no access question to answer.
  it('says nothing when the store has one branch', () => {
    expect(branchAccessLabel(person({ userId: 'u1' }), 1)).toBe('');
  });

  it('names the one branch a member is tied to', () => {
    expect(branchAccessLabel(person({ userId: 'u1', branchNames: ['Koodbuur'] }), 2)).toBe('Koodbuur');
  });

  it('counts when a member is tied to several but not all', () => {
    expect(branchAccessLabel(person({ userId: 'u1', branchNames: ['Koodbuur', 'Main'] }), 4)).toBe('2 branches');
  });

  // Ownership is not an assignment row, so an owner is never labelled off one.
  it('always gives the owner every branch, whatever their rows say', () => {
    expect(branchAccessLabel(person({ userId: 'u1', isOwner: true, branchNames: ['Main'] }), 3)).toBe('All branches');
  });
});

describe('sortPeople', () => {
  it('puts the owner first, then active people, then those who have left', () => {
    const sorted = sortPeople([
      person({ userId: 'gone', name: 'Cabdi', active: false }),
      person({ userId: 'cashier', name: 'Sahra' }),
      person({ userId: 'owner', name: 'Faadumo', isOwner: true }),
    ]);
    expect(sorted.map((p) => p.userId)).toEqual(['owner', 'cashier', 'gone']);
  });

  it('orders equal people by name so the list does not reshuffle between loads', () => {
    const sorted = sortPeople([
      person({ userId: 'n', name: 'Nasra' }),
      person({ userId: 'm', name: 'Maxamed' }),
    ]);
    expect(sorted.map((p) => p.name)).toEqual(['Maxamed', 'Nasra']);
  });
});

describe('teamSummary', () => {
  it('names the team and counts who has left', () => {
    expect(
      teamSummary([
        person({ userId: 'o', name: 'Faadumo', isOwner: true }),
        person({ userId: 'a', name: 'Maxamed Aadan' }),
        person({ userId: 'b', name: 'Sahra Ismaaciil' }),
        person({ userId: 'c', name: 'Cabdi Jibriil', active: false }),
      ])
    ).toBe('Maxamed, Sahra · 1 who has left');
  });

  it('is null for a one-person shop, which has no team to summarise', () => {
    expect(teamSummary([person({ userId: 'o', isOwner: true })])).toBeNull();
  });

  it('stops naming people after three and counts the rest', () => {
    expect(
      teamSummary([
        person({ userId: 'o', isOwner: true }),
        person({ userId: '1', name: 'Ayaan A' }),
        person({ userId: '2', name: 'Bashir B' }),
        person({ userId: '3', name: 'Caasho C' }),
        person({ userId: '4', name: 'Deeqa D' }),
      ])
    ).toBe('Ayaan, Bashir, Caasho +1');
  });
});

describe('contactPhone', () => {
  const branches = [branch({ id: 'l1', isPrimary: true, phone: '0634418820' })];

  it('prefers the owner’s own number', () => {
    expect(contactPhone(person({ userId: 'o', isOwner: true, phone: '0637710043' }), branches)).toBe('0637710043');
  });

  it('falls back to the primary branch when the owner has no number', () => {
    expect(contactPhone(person({ userId: 'o', isOwner: true }), branches)).toBe('0634418820');
  });

  it('is null when there is nothing to dial', () => {
    expect(contactPhone(null, [branch({ id: 'l1', isPrimary: true })])).toBeNull();
  });
});

describe('personMatchesQuery', () => {
  const sahra = person({ userId: 'u', name: 'Sahra Ismaaciil', email: 'sahra@hooyo.so', phone: '063 441 8820' });

  it('matches a name case-insensitively', () => {
    expect(personMatchesQuery(sahra, 'sahra')).toBe(true);
  });

  it('matches an email', () => {
    expect(personMatchesQuery(sahra, 'hooyo.so')).toBe(true);
  });

  // Operators read the last four digits off a screen; the stored number has
  // spaces in it, so a raw substring test would miss.
  it('matches the last digits of a phone number regardless of spacing', () => {
    expect(personMatchesQuery(sahra, '8820')).toBe(true);
  });

  it('does not match something absent', () => {
    expect(personMatchesQuery(sahra, 'maxamed')).toBe(false);
  });
});

describe('cityLabel', () => {
  it('names the primary branch’s city', () => {
    expect(cityLabel([branch({ id: 'a', isPrimary: true, city: 'Hargeisa' })])).toBe('Hargeisa');
  });

  it('counts the other branches rather than listing three towns', () => {
    expect(
      cityLabel([
        branch({ id: 'a', isPrimary: true, city: 'Burco' }),
        branch({ id: 'b', city: 'Hargeisa' }),
        branch({ id: 'c', city: 'Berbera' }),
      ])
    ).toBe('Burco +2');
  });

  it('is null when no branch has a city', () => {
    expect(cityLabel([branch({ id: 'a', isPrimary: true, city: null })])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/shop-people.test.ts`
Expected: FAIL — `Cannot find module '@/lib/shop-people'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/shop-people.ts`:

```ts
// Who works at a store, and where — as pure functions over already-fetched
// rows.
//
// Split out of the console's components for the reason src/lib/attention.ts is
// split out of dashboard.tsx: the rules here are easy to get subtly wrong and
// impossible to check by looking at one store's data on a screen. One of them
// is load-bearing on a security boundary's meaning (see branchAccessLabel), so
// it is worth a test rather than a glance.

export type ShopPerson = {
  userId: string;
  shopId: string;
  /** Already falls back to the email's local part upstream; never empty. */
  name: string;
  email: string | null;
  phone: string | null;
  roleName: string;
  permissions: string[];
  /** True when shops.owner_id names them. Authority, not a role label. */
  isOwner: boolean;
  active: boolean;
  joinedAt: string;
  /**
   * The branches they are assigned to. EMPTY MEANS EVERY BRANCH — see
   * can_access_location() in 20260814000000. Never read this as "no access".
   */
  branchNames: string[];
};

export type Branch = {
  id: string;
  name: string;
  city: string | null;
  neighborhood: string | null;
  phone: string | null;
  isPrimary: boolean;
};

/**
 * What to put on a person's row about where they can work.
 *
 * Empty `branchNames` is access to everything, which is the opposite of what
 * the array looks like. The owner is hard-coded to the same answer because
 * their access comes from owns_shop() and never from an assignment row at all.
 *
 * Returns '' for a single-branch store — there is no access question to
 * answer, and a chip reading "All branches" beside a store with one branch is
 * noise.
 */
export function branchAccessLabel(person: ShopPerson, branchCount: number): string {
  if (branchCount <= 1) return '';
  const all = person.isOwner || person.branchNames.length === 0;
  if (all) return branchCount === 2 ? 'Both branches' : 'All branches';
  if (person.branchNames.length === 1) return person.branchNames[0];
  if (person.branchNames.length >= branchCount) return branchCount === 2 ? 'Both branches' : 'All branches';
  return `${person.branchNames.length} branches`;
}

/** Owner first, then everyone still working there, then everyone who has left. */
export function sortPeople(people: ShopPerson[]): ShopPerson[] {
  const rank = (p: ShopPerson) => (p.isOwner ? 0 : p.active ? 1 : 2);
  return [...people].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The first word of a name — what a person is called in a summary line. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * The one line that stands in for the whole team in the drawer. Often the
 * entire answer, which saves opening the roster at all.
 *
 * Null for a one-person shop: an owner with nobody else is a complete answer,
 * not a shortfall, and "0 others" is a worse way of saying it.
 */
export function teamSummary(people: ShopPerson[]): string | null {
  const others = people.filter((p) => !p.isOwner);
  if (others.length === 0) return null;
  const active = sortPeople(others.filter((p) => p.active));
  const gone = others.length - active.length;
  const named = active.slice(0, 3).map((p) => firstName(p.name));
  const extra = active.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) parts.push(named.join(', ') + (extra > 0 ? ` +${extra}` : ''));
  if (gone > 0) parts.push(`${gone} who ${gone === 1 ? 'has' : 'have'} left`);
  return parts.join(' · ');
}

/**
 * Which number to offer for a store, in order: the owner's own, then the
 * primary branch's — the one printed on their receipts, which is today's
 * behaviour kept as the fallback rather than removed.
 */
export function contactPhone(person: ShopPerson | null, branches: Branch[]): string | null {
  if (person?.phone) return person.phone;
  const primary = branches.find((b) => b.isPrimary) ?? branches[0];
  return primary?.phone ?? null;
}

/** Digits only, so a search for "8820" finds "063 441 8820". */
function digits(value: string): string {
  return value.replace(/\D/g, '');
}

export function personMatchesQuery(person: ShopPerson, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (person.name.toLowerCase().includes(q)) return true;
  if (person.email?.toLowerCase().includes(q)) return true;
  const qDigits = digits(q);
  if (qDigits.length >= 3 && person.phone && digits(person.phone).includes(qDigits)) return true;
  return false;
}

/**
 * Where the business is, for a one-line cell: the primary branch's city, plus a
 * count when there are others. Three towns competing with the owner's name for
 * one line is how that line stops being readable.
 */
export function cityLabel(branches: Branch[]): string | null {
  const primary = branches.find((b) => b.isPrimary) ?? branches[0];
  if (!primary?.city) return null;
  const others = branches.length - 1;
  return others > 0 ? `${primary.city} +${others}` : primary.city;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/shop-people.test.ts`
Expected: PASS — 20 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shop-people.ts src/lib/__tests__/shop-people.test.ts
git commit -m "feat(platform): the rules for who works where, with the empty-means-everywhere trap tested"
```

---

### Task 3: The data layer

**Files:**
- Modify: `src/lib/platform.ts` (the `PlatformShopRow` type at `:10-39`, `listPlatformShops` at `:185-256`)
- Test: `src/lib/__tests__/platform-shop-people.test.ts`

**Interfaces:**
- Consumes: `ShopPerson`, `Branch`, `sortPeople`, `contactPhone` from Task 2.
- Produces:
  - `listShopPeople(shopIds: string[]): Promise<Map<string, ShopPerson[]>>`
  - `PlatformShopRow` gains `branches: Branch[]`, `people: ShopPerson[]`, `owner: ShopPerson | null`.
  - `PlatformShopRow.contactPhone` keeps its current meaning (primary branch's number) — Task 5 and Task 8 read the new `owner`/`branches` fields through `contactPhone()` from Task 2 instead.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/platform-shop-people.test.ts`:

```ts
import { listShopPeople } from '@/lib/platform';

const rpc = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));

beforeEach(() => rpc.mockReset());

const row = (over: Record<string, unknown>) => ({
  shop_id: 'shop-1',
  user_id: 'u1',
  full_name: 'Sahra Ismaaciil',
  email: 'sahra@hooyo.so',
  phone: '0634418820',
  role_name: 'Cashier',
  role_permissions: ['sales.record'],
  is_owner: false,
  active: true,
  joined_at: '2026-08-03T09:00:00Z',
  branch_names: ['Koodbuur'],
  ...over,
});

describe('listShopPeople', () => {
  it('asks for exactly the shops it was given', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await listShopPeople(['shop-1', 'shop-2']);
    expect(rpc).toHaveBeenCalledWith('platform_shop_people', { p_shop_ids: ['shop-1', 'shop-2'] });
  });

  // One call for the whole console, not one per drawer. A per-store fetch
  // would be N+1 against the busiest screen in the portal.
  it('does not call the database at all for an empty list', async () => {
    const people = await listShopPeople([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(people.size).toBe(0);
  });

  it('groups people by shop and maps every column', async () => {
    rpc.mockResolvedValue({
      data: [row({}), row({ shop_id: 'shop-2', user_id: 'u2', is_owner: true, branch_names: [] })],
      error: null,
    });
    const people = await listShopPeople(['shop-1', 'shop-2']);
    expect(people.get('shop-1')).toEqual([
      {
        userId: 'u1',
        shopId: 'shop-1',
        name: 'Sahra Ismaaciil',
        email: 'sahra@hooyo.so',
        phone: '0634418820',
        roleName: 'Cashier',
        permissions: ['sales.record'],
        isOwner: false,
        active: true,
        joinedAt: '2026-08-03T09:00:00Z',
        branchNames: ['Koodbuur'],
      },
    ]);
    expect(people.get('shop-2')?.[0].isOwner).toBe(true);
  });

  // The provisioning trigger falls back to the email's local part, so a truly
  // blank name is rare -- but an empty row is never rendered.
  it('falls back to "Owner" rather than rendering a nameless row', async () => {
    rpc.mockResolvedValue({ data: [row({ full_name: null, is_owner: true })], error: null });
    const people = await listShopPeople(['shop-1']);
    expect(people.get('shop-1')?.[0].name).toBe('Owner');
  });

  it('falls back to "Team member" for a nameless non-owner', async () => {
    rpc.mockResolvedValue({ data: [row({ full_name: null })], error: null });
    const people = await listShopPeople(['shop-1']);
    expect(people.get('shop-1')?.[0].name).toBe('Team member');
  });

  it('throws when the read fails, so the caller can say so', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(listShopPeople(['shop-1'])).rejects.toBeDefined();
  });

  it('returns people already sorted, owner first', async () => {
    rpc.mockResolvedValue({
      data: [
        row({ user_id: 'gone', full_name: 'Cabdi', active: false }),
        row({ user_id: 'owner', full_name: 'Faadumo', is_owner: true }),
      ],
      error: null,
    });
    const people = await listShopPeople(['shop-1']);
    expect(people.get('shop-1')?.map((p) => p.userId)).toEqual(['owner', 'gone']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/lib/__tests__/platform-shop-people.test.ts`
Expected: FAIL — `listShopPeople is not a function`.

- [ ] **Step 3: Add `listShopPeople` to `src/lib/platform.ts`**

Add this import beside the existing ones at the top of the file:

```ts
import { sortPeople, type Branch, type ShopPerson } from '@/lib/shop-people';
```

Re-export the two types so console components have one import site, next to the existing `export { whatsappLink } from '@/lib/whatsapp';`:

```ts
export type { Branch, ShopPerson } from '@/lib/shop-people';
```

Then add the function, after `listPlatformShops`:

```ts
// Who works at each of these stores, in ONE call for the whole console.
//
// Batched rather than fetched per drawer, the same shape listSupportThreads()
// uses for author profiles: the console already holds every store in memory,
// and a per-store read would be N+1 against the busiest screen in the portal.
//
// Goes through platform_shop_people() (20260829000000) rather than a select on
// shop_members: that table's select grant is column-unrestricted, so a
// row-scoped policy would hand back pay_type and pay_rate_cents along with the
// name and role the console shows. The function returns only what is drawn.
export async function listShopPeople(shopIds: string[]): Promise<Map<string, ShopPerson[]>> {
  const people = new Map<string, ShopPerson[]>();
  // `any` on an empty list is a request that can only return nothing.
  if (shopIds.length === 0) return people;

  const { data, error } = await supabase.rpc('platform_shop_people', { p_shop_ids: shopIds });
  if (error) throw error;

  for (const row of (data ?? []) as any[]) {
    const person: ShopPerson = {
      userId: row.user_id,
      shopId: row.shop_id,
      // Never an empty row: the provisioning trigger (20260823000000) already
      // falls back to the email's local part, so this is the last resort
      // rather than the common case -- and it never invents a name from the
      // store's.
      name: row.full_name?.trim() || (row.is_owner ? 'Owner' : 'Team member'),
      email: row.email,
      phone: row.phone,
      roleName: row.role_name,
      permissions: row.role_permissions ?? [],
      isOwner: row.is_owner,
      active: row.active,
      joinedAt: row.joined_at,
      // Empty means EVERY branch. Carried through untouched; the label is
      // computed by branchAccessLabel(), which knows that.
      branchNames: row.branch_names ?? [],
    };
    const existing = people.get(person.shopId);
    if (existing) existing.push(person);
    else people.set(person.shopId, [person]);
  }

  for (const [shopId, list] of people) people.set(shopId, sortPeople(list));
  return people;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/lib/__tests__/platform-shop-people.test.ts`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Widen the locations read and carry the branches**

In `src/lib/platform.ts`, change the `shop_locations` query inside `listPlatformShops` (currently at `:190`) from:

```ts
    supabase.from('shop_locations').select('shop_id, contact_phone, city, is_primary').eq('is_primary', true),
```

to:

```ts
    // Every branch, not just the primary one. The operator policy
    // ("operators read locations", 20260818000500) already covers all of them
    // -- this filter was throwing away rows the console was allowed to see and
    // then rendering "2 / 3 branches" as a number with no places in it.
    supabase.from('shop_locations').select('id, shop_id, name, contact_phone, city, neighborhood, is_primary'),
```

Replace the `primary` map built at `:196` with a per-shop grouping, primary first:

```ts
  const branchesByShop = new Map<string, Branch[]>();
  for (const row of (locationsRes.data ?? []) as any[]) {
    const branch: Branch = {
      id: row.id,
      name: row.name,
      city: row.city,
      neighborhood: row.neighborhood,
      phone: row.contact_phone,
      isPrimary: row.is_primary,
    };
    const existing = branchesByShop.get(row.shop_id);
    if (existing) existing.push(branch);
    else branchesByShop.set(row.shop_id, [branch]);
  }
  // Primary first, then by name: the drawer reads this top to bottom and the
  // main branch is the one an operator is looking for.
  for (const [shopId, list] of branchesByShop) {
    branchesByShop.set(
      shopId,
      [...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name))
    );
  }
```

In the returned object (currently `:236-254`), replace the two lines that read the old `primary` map:

```ts
      contactPhone: primary.get(shop.id)?.contact_phone ?? null,
      city: primary.get(shop.id)?.city ?? null,
```

with:

```ts
      // Kept for the callers that already read them, and still the PRIMARY
      // branch's — the number on their receipts.
      contactPhone: branchesByShop.get(shop.id)?.find((b) => b.isPrimary)?.phone ?? null,
      city: branchesByShop.get(shop.id)?.find((b) => b.isPrimary)?.city ?? null,
      branches: branchesByShop.get(shop.id) ?? [],
      people: [],
      owner: null,
```

Add the three fields to the `PlatformShopRow` type (at `:10-39`), after `city`:

```ts
  /** Every branch, primary first. Their trading addresses, not private data. */
  branches: Branch[];
  /**
   * Everyone who works here, owner first. Filled in by the console after
   * listShopPeople() resolves, so a roster that fails to load leaves this
   * empty rather than taking the whole store row down with it.
   */
  people: ShopPerson[];
  /** shops.owner_id's person, resolved once so callers do not search a list. */
  owner: ShopPerson | null;
```

- [ ] **Step 6: Wire the load in `src/app/platform/index.tsx`**

Add `listShopPeople` to the import from `@/lib/platform`. Then, inside `reload()` after the six-way `Promise.all` resolves and before `setShops(shopRows)`, add:

```ts
      // People load AFTER the stores, because the call needs their ids -- and
      // it fails ALONE. A roster that will not load must not take Money, Usage
      // and the Danger zone down with it, which is the lesson of the support
      // read that once left every tab spinning.
      let peopleByShop = new Map<string, ShopPerson[]>();
      try {
        peopleByShop = await listShopPeople(shopRows.map((s) => s.shopId));
        setPeopleError(null);
      } catch (err) {
        setPeopleError(err instanceof Error ? err.message : 'Could not load who works at these stores.');
      }
      for (const shop of shopRows) {
        shop.people = peopleByShop.get(shop.shopId) ?? [];
        shop.owner = shop.people.find((p) => p.isOwner) ?? null;
      }
```

Add the state it needs, beside the existing `error` state:

```ts
  // Set when the roster read alone fails. Separate from `error` on purpose:
  // that one blanks the console, and a missing roster should not.
  const [peopleError, setPeopleError] = useState<string | null>(null);
```

Pass it into the drawer so the failure is stated where the roster would have been:

```tsx
          <ShopDrawer
            shop={selectedShop}
            plans={plans}
            peopleError={peopleError}
```

- [ ] **Step 7: Run the full platform test suite and the type checker**

Run: `npx jest src/lib/__tests__/platform-shop-people.test.ts src/components/platform && npx tsc --noEmit`
Expected: PASS, and no type errors. `tsc` will fail on any test fixture that builds a `PlatformShopRow` without the three new fields — add `branches: []`, `people: []`, `owner: null` to those fixtures.

- [ ] **Step 8: Commit**

```bash
git add src/lib/platform.ts src/lib/__tests__/platform-shop-people.test.ts src/app/platform/index.tsx src/components/platform
git commit -m "feat(platform): load the people and every branch, and let a missing roster fail alone"
```

---

### Task 4: The WhatsApp and mail buttons

**Files:**
- Create: `src/components/platform/whatsapp-button.tsx`
- Test: `src/components/platform/__tests__/whatsapp-button.test.tsx`

**Interfaces:**
- Consumes: `whatsappLink` from `@/lib/whatsapp`, `openExternalUrl` from `@/lib/external-url`.
- Produces: `<WhatsAppButton phone message label />` and `<EmailButton email label />`, plus `WHATSAPP_GREEN` and `WHATSAPP_WASH` constants.

- [ ] **Step 1: Write the failing tests**

Create `src/components/platform/__tests__/whatsapp-button.test.tsx`:

```tsx
import { act, create } from 'react-test-renderer';
import { Pressable } from 'react-native';

import { EmailButton, WhatsAppButton } from '@/components/platform/whatsapp-button';
import { openExternalUrl } from '@/lib/external-url';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const openMock = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;
beforeEach(() => openMock.mockReset());

describe('WhatsAppButton', () => {
  it('opens a chat with the number normalised and the message written', () => {
    const tree = create(<WhatsAppButton phone="063 441 8820" message="Hi Faadumo" label="WhatsApp Faadumo" />);
    act(() => tree.root.findByType(Pressable).props.onPress());
    expect(openMock).toHaveBeenCalledWith('https://wa.me/252634418820?text=Hi%20Faadumo');
  });

  // Offering to message someone whose number cannot be dialled is a worse
  // answer than not offering -- so the button is absent, not disabled.
  it('renders nothing at all when there is no number', () => {
    const tree = create(<WhatsAppButton phone={null} message="Hi" label="WhatsApp" />);
    expect(tree.root.findAllByType(Pressable)).toHaveLength(0);
  });

  it('renders nothing when the number is too short to dial', () => {
    const tree = create(<WhatsAppButton phone="0634" message="Hi" label="WhatsApp" />);
    expect(tree.root.findAllByType(Pressable)).toHaveLength(0);
  });

  // The word removed from the screen has to still be there for a screen reader.
  it('carries the person it reaches in its accessibility label', () => {
    const tree = create(<WhatsAppButton phone="0634418820" message="Hi" label="WhatsApp Faadumo Cabdi" />);
    expect(tree.root.findByType(Pressable).props['aria-label']).toBe('WhatsApp Faadumo Cabdi');
  });
});

describe('EmailButton', () => {
  it('opens a mail composer', () => {
    const tree = create(<EmailButton email="faadumo@hooyo.so" label="Email Faadumo" />);
    act(() => tree.root.findByType(Pressable).props.onPress());
    expect(openMock).toHaveBeenCalledWith('mailto:faadumo@hooyo.so');
  });

  it('renders nothing without an address', () => {
    const tree = create(<EmailButton email={null} label="Email" />);
    expect(tree.root.findAllByType(Pressable)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/components/platform/__tests__/whatsapp-button.test.tsx`
Expected: FAIL — `Cannot find module '@/components/platform/whatsapp-button'`.

- [ ] **Step 3: Write the component**

Create `src/components/platform/whatsapp-button.tsx`:

```tsx
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { openExternalUrl } from '@/lib/external-url';
import { whatsappLink } from '@/lib/whatsapp';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// WhatsApp's own green. The one brand colour in the console that is not a
// bento token, because it is not ours to restyle: a green circle IS the
// affordance, and a grey one would not be recognised as it.
export const WHATSAPP_GREEN = '#1fa855';
export const WHATSAPP_WASH = '#e7f6ed';

/**
 * Opens WhatsApp with a number and a first line already written.
 *
 * Renders NOTHING when the number cannot be dialled, per the note in
 * src/lib/whatsapp.ts: a caller that draws an affordance should ask
 * whatsappLink() and hide itself when it returns null, because offering to
 * message someone unreachable is worse than not offering.
 */
export function WhatsAppButton({
  phone,
  message,
  label,
}: {
  phone: string | null | undefined;
  message: string;
  /** Spoken by a screen reader — the word the glyph replaced. */
  label: string;
}) {
  const link = whatsappLink(phone, message);
  if (!link) return null;
  return (
    <Pressable
      onPress={() => openExternalUrl(link)}
      style={({ hovered }) => [styles.button, styles.wa, hovered && styles.hovered]}
      hitSlop={8}
      aria-label={label}
      role="button"
    >
      <Text style={styles.waGlyph}>✆</Text>
    </Pressable>
  );
}

/** The fallback when there is no number. Every owner row has an email. */
export function EmailButton({ email, label }: { email: string | null | undefined; label: string }) {
  if (!email) return null;
  return (
    <Pressable
      onPress={() => openExternalUrl(`mailto:${email}`)}
      style={({ hovered }) => [styles.button, styles.mail, hovered && styles.hovered]}
      hitSlop={8}
      aria-label={label}
      role="button"
    >
      <Text style={styles.mailGlyph}>✉</Text>
    </Pressable>
  );
}

/** Neither a number nor an address — said once, quietly, rather than drawn. */
export function NoContact({ children = 'no contact' }: { children?: string }) {
  return (
    <View>
      <Text style={styles.none}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // 34pt drawn, 44pt+ pressable via hitSlop.
  button: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hovered: { opacity: 0.8 },
  wa: { backgroundColor: WHATSAPP_WASH },
  waGlyph: { color: WHATSAPP_GREEN, fontSize: 16, fontWeight: '800' },
  mail: { backgroundColor: theme.bentoSoft },
  mailGlyph: { color: theme.bentoMuted, fontSize: 15 },
  none: { color: theme.bentoMuted2, fontSize: 11 },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/components/platform/__tests__/whatsapp-button.test.tsx`
Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/components/platform/whatsapp-button.tsx src/components/platform/__tests__/whatsapp-button.test.tsx
git commit -m "feat(platform): a WhatsApp glyph that hides itself rather than offering a number it cannot dial"
```

---

### Task 5: The Stores table gains a person and a place

**Files:**
- Modify: `src/components/platform/shops-tab.tsx` (columns at `:100-188`, filter at `:55-75`, `ShopCard` at `:279-311`)
- Test: `src/components/platform/__tests__/shops-tab-contacts.test.tsx`

**Interfaces:**
- Consumes: `cityLabel`, `contactPhone`, `personMatchesQuery` (Task 2); `PlatformShopRow.owner`/`.branches` (Task 3); `WhatsAppButton` (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Create `src/components/platform/__tests__/shops-tab-contacts.test.tsx`:

```tsx
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ShopsTab } from '@/components/platform/shops-tab';
import type { PlatformShopRow, ShopPerson } from '@/lib/platform';
import type { Plan } from '@/lib/subscriptions';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));

const owner = (over: Partial<ShopPerson> = {}): ShopPerson => ({
  userId: 'owner-1',
  shopId: 'shop-1',
  name: 'Faadumo Cabdi',
  email: 'faadumo@hooyo.so',
  phone: '0634418820',
  roleName: 'Owner',
  permissions: [],
  isOwner: true,
  active: true,
  joinedAt: '2026-07-14T09:00:00Z',
  branchNames: [],
  ...over,
});

const shop = (over: Partial<PlatformShopRow> = {}): PlatformShopRow => ({
  shopId: 'shop-1',
  shopName: 'Hooyo Market',
  ownerId: 'owner-1',
  createdAt: '2026-07-14T09:00:00Z',
  planKey: 'standard',
  planName: 'Standard',
  storedPlanKey: 'standard',
  storedPlanName: 'Standard',
  retiringTo: null,
  status: 'trialing',
  trialEndsAt: '2026-08-18T09:00:00Z',
  currentPeriodEnd: null,
  manualStatus: 'active',
  usage: {},
  limits: {},
  contactPhone: '0634418820',
  city: 'Hargeisa',
  branches: [
    { id: 'l1', name: 'Main', city: 'Hargeisa', neighborhood: 'Jigjiga Yar', phone: '0634418820', isPrimary: true },
  ],
  people: [owner()],
  owner: owner(),
  ...over,
});

const plans: Plan[] = [];

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((n) => {
    const c = n.props.children;
    return typeof c === 'string' ? [c] : [];
  });
}

function render(rows: PlatformShopRow[]) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<ShopsTab shops={rows} plans={plans} compact={false} selected={null} onSelect={() => {}} />);
  });
  return tree;
}

describe('the Store cell', () => {
  it('names the owner and the city beside the plan', () => {
    const tree = render([shop()]);
    expect(texts(tree)).toContain('Faadumo Cabdi · Hargeisa · Standard');
  });

  it('counts the other branches rather than listing three towns', () => {
    const tree = render([
      shop({
        branches: [
          { id: 'l1', name: 'Main', city: 'Burco', neighborhood: null, phone: null, isPrimary: true },
          { id: 'l2', name: 'Two', city: 'Hargeisa', neighborhood: null, phone: null, isPrimary: false },
          { id: 'l3', name: 'Three', city: 'Berbera', neighborhood: null, phone: null, isPrimary: false },
        ],
      }),
    ]);
    expect(texts(tree)).toContain('Faadumo Cabdi · Burco +2 · Standard');
  });

  it('falls back to the plan alone when the roster did not load', () => {
    const tree = render([shop({ people: [], owner: null, branches: [] })]);
    expect(texts(tree)).toContain('Standard');
  });
});

describe('search', () => {
  function search(tree: ReactTestRenderer, query: string) {
    act(() => tree.root.findAllByType(TextInput)[0].props.onChangeText(query));
  }

  it('finds a store by its owner’s name', () => {
    const tree = render([shop(), shop({ shopId: 'shop-2', shopName: 'Xamdi Pharmacy', people: [], owner: null })]);
    search(tree, 'faadumo');
    expect(texts(tree)).toContain('Hooyo Market');
    expect(texts(tree)).not.toContain('Xamdi Pharmacy');
  });

  it('finds a store by the last digits of the owner’s number', () => {
    const tree = render([shop()]);
    search(tree, '8820');
    expect(texts(tree)).toContain('Hooyo Market');
  });

  it('finds a store by a branch city', () => {
    const tree = render([shop({ branches: [{ id: 'l1', name: 'Main', city: 'Burco', neighborhood: null, phone: null, isPrimary: true }] })]);
    search(tree, 'burco');
    expect(texts(tree)).toContain('Hooyo Market');
  });

  it('still finds a store by its own name', () => {
    const tree = render([shop()]);
    search(tree, 'hooyo');
    expect(texts(tree)).toContain('Hooyo Market');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/components/platform/__tests__/shops-tab-contacts.test.tsx`
Expected: FAIL — the Store cell renders `Standard` alone, and the owner/city/phone searches return no rows.

- [ ] **Step 3: Update the Store cell and the filter**

In `src/components/platform/shops-tab.tsx`, add the imports:

```ts
import { WhatsAppButton } from '@/components/platform/whatsapp-button';
import { cityLabel, contactPhone, personMatchesQuery } from '@/lib/shop-people';
```

Replace the `meta` expression inside the `shop` column's `NameCell` (currently `:119-125`) with a helper defined above the component, so the table and `ShopCard` cannot drift:

```ts
// Who runs it, where it is, and what it pays — in that order, because that is
// the order an operator reads a row in. The plan clause keeps both divergences
// the old meta line carried: "current → future" before a retirement date, and
// "billed → entitled" after one.
function storeMeta(shop: PlatformShopRow): string {
  const planPart =
    shop.retiringTo && shop.retiringTo !== shop.planName
      ? `${shop.planName} → ${shop.retiringTo}`
      : shop.storedPlanKey !== shop.planKey
        ? `${shop.storedPlanName} → ${shop.planName}`
        : shop.planName;
  return [shop.owner?.name, cityLabel(shop.branches), planPart].filter(Boolean).join(' · ');
}
```

and use it:

```tsx
        <NameCell title={shop.shopName} meta={storeMeta(shop)} />
```

Replace the `joined` column (currently `:143-148`) with a Contact column. A signup date is read once a quarter; a number is read every time a row is opened, and Joined survives in the drawer's header line:

```tsx
    {
      key: 'contact',
      header: 'Contact',
      width: 190,
      render: (shop) => {
        const phone = contactPhone(shop.owner, shop.branches);
        return (
          <View style={styles.contactCell}>
            <WhatsAppButton
              phone={phone}
              message={`Hi ${shop.owner?.name ?? shop.shopName} — this is Kaiibi.`}
              label={`WhatsApp ${shop.owner?.name ?? shop.shopName}`}
            />
            {phone ? (
              <Text style={styles.contactPhone} numberOfLines={1}>
                {phone}
              </Text>
            ) : (
              <Text style={styles.contactNone}>no number</Text>
            )}
          </View>
        );
      },
    },
```

Add the styles:

```ts
  contactCell: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  contactPhone: { fontSize: 11.5, color: theme.bentoMuted, flexShrink: 1 },
  contactNone: { fontSize: 11, color: theme.bentoMuted2 },
```

Widen the search predicate inside `filtered` (currently `:64-73`) by adding two clauses to the existing `return`:

```ts
      return (
        shop.shopName.toLowerCase().includes(q) ||
        shop.planKey.includes(q) ||
        shop.storedPlanKey.includes(q) ||
        shop.status.includes(q) ||
        // Operators think in people and towns; the box used to refuse both.
        shop.people.some((p) => personMatchesQuery(p, q)) ||
        shop.branches.some((b) => b.city?.toLowerCase().includes(q))
      );
```

Update the search placeholder (`:222`) to `"Search store, owner, city, plan, or status"`.

- [ ] **Step 4: Update the compact card**

In `ShopCard`, replace the meta line (currently `:296-298`) with:

```tsx
      <Text style={styles.shopMeta}>{storeMeta(shop)}</Text>
      <Text style={styles.shopMeta}>joined {fmtDate(shop.createdAt)}</Text>
```

and add the contact row just above the closing `</Pressable>`:

```tsx
      <View style={styles.cardContact}>
        <WhatsAppButton
          phone={contactPhone(shop.owner, shop.branches)}
          message={`Hi ${shop.owner?.name ?? shop.shopName} — this is Kaiibi.`}
          label={`WhatsApp ${shop.owner?.name ?? shop.shopName}`}
        />
      </View>
```

with:

```ts
  cardContact: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/components/platform/__tests__/shops-tab-contacts.test.tsx`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/components/platform/shops-tab.tsx src/components/platform/__tests__/shops-tab-contacts.test.tsx
git commit -m "feat(platform): a store row that names who runs it, where it is, and how to reach them"
```

---

### Task 6: The People list component

**Files:**
- Create: `src/components/platform/people-list.tsx`

**Interfaces:**
- Consumes: `ShopPerson`, `Branch`, `branchAccessLabel` (Task 2); `WhatsAppButton`, `EmailButton`, `NoContact` (Task 4).
- Produces:
  - `<PersonRow person branchCount expanded onToggle first />`
  - `<BranchRow branch first />`
  - `<PeopleGroups people branchCount />` — the two grouped lists with their headings.

- [ ] **Step 1: Write the component**

There is no separate test step here: this file is pure presentation with no decisions of its own (every rule it applies comes from Task 2, which is tested), and Task 7 renders it through the drawer and asserts on the output. Create `src/components/platform/people-list.tsx`:

```tsx
import { Fragment, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EmailButton, NoContact, WhatsAppButton } from '@/components/platform/whatsapp-button';
import { Colors } from '@/constants/theme';
import { branchAccessLabel, sortPeople, type Branch, type ShopPerson } from '@/lib/shop-people';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One person, and one branch. Rules between rows rather than a bordered box
// each, the same way the Overview's attention list is built: the card is
// already the container.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function PersonRow({
  person,
  branchCount,
  expanded,
  onToggle,
  first,
}: {
  person: ShopPerson;
  branchCount: number;
  expanded: boolean;
  onToggle: () => void;
  first: boolean;
}) {
  const where = branchAccessLabel(person, branchCount);
  // Contact details are not offered for someone who has left. They are still
  // in the store's own records; this console has no reason to reach them.
  const reachable = person.active;
  return (
    <View>
      <Pressable
        onPress={onToggle}
        style={[styles.row, first && styles.rowFirst]}
        aria-expanded={expanded}
        aria-label={`${person.name}, ${person.roleName}`}
      >
        <View style={[styles.avatar, person.isOwner && styles.avatarOwner]}>
          <Text style={[styles.avatarText, person.isOwner && styles.avatarTextOwner]}>{initials(person.name)}</Text>
        </View>
        <View style={styles.main}>
          <View style={styles.titleRow}>
            <Text style={[styles.name, !person.active && styles.dim]} numberOfLines={1}>
              {person.name}
            </Text>
            <View style={[styles.pill, person.isOwner && styles.pillOwner, !person.active && styles.pillOff]}>
              <Text style={[styles.pillText, person.isOwner && styles.pillTextOwner]}>{person.roleName}</Text>
            </View>
            {where ? (
              <View style={[styles.pill, styles.pillWhere]}>
                <Text style={[styles.pillText, styles.pillTextWhere]}>{where}</Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.line, !person.active && styles.dim]} numberOfLines={1}>
            {reachable
              ? [person.email, person.phone ?? 'no phone on file'].filter(Boolean).join(' · ')
              : `signed up ${person.joinedAt.slice(0, 10)}`}
          </Text>
        </View>
        <View style={styles.actions}>
          {reachable ? (
            <>
              <WhatsAppButton
                phone={person.phone}
                message={`Hi ${person.name.split(' ')[0]} — this is Kaiibi.`}
                label={`WhatsApp ${person.name}`}
              />
              <EmailButton email={person.email} label={`Email ${person.name}`} />
            </>
          ) : (
            <NoContact />
          )}
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.detail}>
          <Detail label="Role" value={person.isOwner ? `${person.roleName} — full authority` : person.roleName} />
          <Detail
            label="Works at"
            value={
              person.isOwner
                ? 'Every branch — always, by ownership'
                : person.branchNames.length === 0
                  ? 'Every branch — no assignment set'
                  : person.branchNames.join(', ')
            }
          />
          <Detail label="Signed up" value={person.joinedAt.slice(0, 10)} />
          {person.active ? (
            <>
              <Detail label="Email" value={person.email ?? 'none on file'} />
              <Detail label="Phone" value={person.phone ?? 'none on file — WhatsApp is not offered'} />
            </>
          ) : (
            <Detail label="Contact" value="withheld while inactive" />
          )}
          {person.permissions.length > 0 ? (
            <Text style={styles.perms}>{`Their role allows: ${person.permissions.join(', ')}`}</Text>
          ) : null}
          <Text style={styles.never}>
            Not shown, and not returned by the query at all: pay, hire date, photo, shifts, or anything they have
            recorded.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailKey}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

export function BranchRow({ branch, first }: { branch: Branch; first: boolean }) {
  const place = [branch.neighborhood, branch.city].filter(Boolean).join(', ');
  return (
    <View style={[styles.row, first && styles.rowFirst]}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>◎</Text>
      </View>
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {branch.name}
          </Text>
          {branch.isPrimary ? (
            <View style={styles.pill}>
              <Text style={styles.pillText}>Main</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.line} numberOfLines={1}>
          {[place || 'no address on file', branch.phone ?? 'no phone on file'].join(' · ')}
        </Text>
      </View>
      <View style={styles.actions}>
        <WhatsAppButton
          phone={branch.phone}
          message={`Hi — this is Kaiibi, about ${branch.name}.`}
          label={`WhatsApp ${branch.name}`}
        />
      </View>
    </View>
  );
}

/**
 * The whole roster, grouped by whether someone still works there.
 *
 * Two headings rather than a status column: "Working here" is who you can talk
 * to, and "No longer here" answers "I spoke to Cabdi in June, what happened?"
 */
export function PeopleGroups({ people, branchCount }: { people: ShopPerson[]; branchCount: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = sortPeople(people);
  const here = sorted.filter((p) => p.active);
  const gone = sorted.filter((p) => !p.active);

  const group = (label: string, list: ShopPerson[]) =>
    list.length === 0 ? null : (
      <Fragment key={label}>
        <Text style={styles.groupLabel}>{label}</Text>
        {list.map((person, i) => (
          <PersonRow
            key={person.userId}
            person={person}
            branchCount={branchCount}
            expanded={open === person.userId}
            onToggle={() => setOpen(open === person.userId ? null : person.userId)}
            first={i === 0}
          />
        ))}
      </Fragment>
    );

  return (
    <View>
      {group('Working here', here)}
      {group('No longer here', gone)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  rowFirst: { borderTopWidth: 0 },
  avatar: { width: 34, height: 34, borderRadius: 12, backgroundColor: theme.bentoSoft, alignItems: 'center', justifyContent: 'center' },
  avatarOwner: { backgroundColor: theme.bentoInk },
  avatarText: { fontSize: 12, fontWeight: '800', color: theme.bentoMuted },
  avatarTextOwner: { color: theme.bentoSurface },
  main: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  name: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk, flexShrink: 1 },
  line: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  dim: { opacity: 0.6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 7 },

  pill: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 },
  pillOwner: { backgroundColor: theme.bentoInk },
  pillOff: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.bentoRule },
  pillWhere: { backgroundColor: theme.bentoAccentWash },
  pillText: { fontSize: 10, fontWeight: '800', color: theme.bentoMuted2 },
  pillTextOwner: { color: theme.bentoSurface },
  pillTextWhere: { color: theme.bentoAccentInk },

  groupLabel: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 14,
    marginBottom: 4,
  },

  detail: { backgroundColor: theme.bentoSoft, borderRadius: 16, padding: 13, marginBottom: 8 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 14, paddingVertical: 3 },
  detailKey: { fontSize: 12, color: theme.bentoMuted },
  detailValue: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2, flexShrink: 1, textAlign: 'right' },
  perms: { fontSize: 11, color: theme.bentoMuted, marginTop: 8, lineHeight: 16 },
  never: { fontSize: 11, color: theme.bentoMuted2, marginTop: 8, lineHeight: 16 },
});
```

- [ ] **Step 2: Check the accent tokens exist**

Run: `grep -n "bentoAccentWash\|bentoAccentInk" src/constants/theme.ts`
Expected: both names present. If either is missing, replace `theme.bentoAccentWash` / `theme.bentoAccentInk` with the accent token names that file actually exports — do **not** write a hex literal into this component.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/platform/people-list.tsx
git commit -m "feat(platform): the person row — role, where they work, and one tap to reach them"
```

---

### Task 7: The drawer's two views

**Files:**
- Modify: `src/components/platform/shop-drawer.tsx` (props at `:23-34`, body from `:78`)
- Test: `src/components/platform/__tests__/shop-drawer-people.test.tsx`

**Interfaces:**
- Consumes: `PeopleGroups`, `BranchRow` (Task 6); `teamSummary` (Task 2); `peopleError` prop (Task 3).
- Produces: `ShopDrawer` gains an optional `peopleError?: string | null` prop. Its other props are unchanged.

- [ ] **Step 1: Write the failing tests**

Create `src/components/platform/__tests__/shop-drawer-people.test.tsx`:

```tsx
import { Pressable, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ShopDrawer } from '@/components/platform/shop-drawer';
import type { PlatformShopRow, ShopPerson } from '@/lib/platform';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/external-url', () => ({ openExternalUrl: jest.fn() }));
jest.mock('@/lib/platform', () => ({
  ...jest.requireActual('@/lib/platform'),
  callPlatformAdmin: jest.fn(),
}));

const person = (over: Partial<ShopPerson> & { userId: string }): ShopPerson => ({
  shopId: 'shop-1',
  name: 'Somebody',
  email: 'somebody@hooyo.so',
  phone: null,
  roleName: 'Cashier',
  permissions: [],
  isOwner: false,
  active: true,
  joinedAt: '2026-08-03T09:00:00Z',
  branchNames: [],
  ...over,
});

const owner = person({ userId: 'o', name: 'Faadumo Cabdi', roleName: 'Owner', isOwner: true, phone: '0634418820' });
const maxamed = person({ userId: 'm', name: 'Maxamed Aadan', roleName: 'Manager', phone: '0637710043' });
const nasra = person({ userId: 'n', name: 'Nasra Xasan', branchNames: ['Koodbuur'] });
const cabdi = person({ userId: 'c', name: 'Cabdi Jibriil', active: false });

const shop: PlatformShopRow = {
  shopId: 'shop-1',
  shopName: 'Hooyo Market',
  ownerId: 'o',
  createdAt: '2026-07-14T09:00:00Z',
  planKey: 'standard',
  planName: 'Standard',
  storedPlanKey: 'standard',
  storedPlanName: 'Standard',
  retiringTo: null,
  status: 'trialing',
  trialEndsAt: '2026-08-18T09:00:00Z',
  currentPeriodEnd: null,
  manualStatus: 'active',
  usage: { staff: 4, locations: 2 },
  limits: { staff: 11, locations: 3 },
  contactPhone: '0634418820',
  city: 'Hargeisa',
  branches: [
    { id: 'l1', name: 'Main', city: 'Hargeisa', neighborhood: 'Jigjiga Yar', phone: '0634418820', isPrimary: true },
    { id: 'l2', name: 'Koodbuur', city: 'Hargeisa', neighborhood: 'Koodbuur', phone: null, isPrimary: false },
  ],
  people: [owner, maxamed, nasra, cabdi],
  owner,
};

function texts(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap((n) => (typeof n.props.children === 'string' ? [n.props.children] : []));
}

function render(over: Partial<PlatformShopRow> = {}, peopleError: string | null = null) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <ShopDrawer
        shop={{ ...shop, ...over }}
        plans={[]}
        peopleError={peopleError}
        onDone={async () => {}}
        onMessage={() => {}}
      />
    );
  });
  return tree;
}

function press(tree: ReactTestRenderer, label: string) {
  const target = tree.root.findAll((n) => n.props?.['aria-label'] === label)[0];
  act(() => target.props.onPress());
}

describe('the store view', () => {
  it('shows the owner in full', () => {
    expect(texts(render())).toContain('Faadumo Cabdi');
  });

  it('summarises the team as one row rather than unrolling it', () => {
    const t = texts(render());
    expect(t).toContain('Maxamed, Nasra · 1 who has left');
    // The other three are behind the tap, not on this screen.
    expect(t).not.toContain('Cabdi Jibriil');
  });

  it('lists every branch with its city', () => {
    const t = texts(render());
    expect(t).toContain('Jigjiga Yar, Hargeisa · 0634418820');
    expect(t).toContain('Koodbuur, Hargeisa · no phone on file');
  });

  it('no longer repeats the seat count as a Usage row', () => {
    expect(texts(render())).not.toContain('Staff');
  });

  it('says so when the roster failed to load, without blanking the drawer', () => {
    const t = texts(render({}, 'permission denied'));
    expect(t.some((s) => s.includes('Could not load who works at this store'))).toBe(true);
    // The rest of the drawer is still there.
    expect(t).toContain('Usage');
  });

  it('says nothing about a team when there is only the owner', () => {
    const t = texts(render({ people: [owner] }));
    expect(t.some((s) => s.includes('who has left'))).toBe(false);
  });
});

describe('the team view', () => {
  it('opens on the roster and names everyone', () => {
    const tree = render();
    press(tree, 'Their team');
    const t = texts(tree);
    expect(t).toContain('Maxamed Aadan');
    expect(t).toContain('Cabdi Jibriil');
    expect(t).toContain('Working here');
    expect(t).toContain('No longer here');
  });

  // The rule can_access_location() enforces, stated the right way round.
  it('labels an unassigned member as reaching every branch', () => {
    const tree = render();
    press(tree, 'Their team');
    expect(texts(tree)).toContain('Both branches');
  });

  it('names the one branch an assigned member is tied to', () => {
    const tree = render();
    press(tree, 'Their team');
    expect(texts(tree)).toContain('Koodbuur');
  });

  it('gives a person’s email and phone when their row is tapped', () => {
    const tree = render();
    press(tree, 'Their team');
    press(tree, 'Maxamed Aadan, Manager');
    const t = texts(tree);
    expect(t).toContain('maxamed@hooyo.so');
    expect(t).toContain('0637710043');
  });

  it('goes back to the store', () => {
    const tree = render();
    press(tree, 'Their team');
    press(tree, 'Back to Hooyo Market');
    expect(texts(tree)).toContain('Usage');
  });
});
```

Note: `maxamed`'s email above comes from the `person()` default (`somebody@hooyo.so`). Change the fixture to `email: 'maxamed@hooyo.so'` when defining `maxamed` so the assertion matches:

```ts
const maxamed = person({ userId: 'm', name: 'Maxamed Aadan', roleName: 'Manager', phone: '0637710043', email: 'maxamed@hooyo.so' });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/components/platform/__tests__/shop-drawer-people.test.tsx`
Expected: FAIL — no People section, no `Their team` control.

- [ ] **Step 3: Add the two views to the drawer**

In `src/components/platform/shop-drawer.tsx`, add the imports:

```ts
import { BranchRow, PeopleGroups, PersonRow } from '@/components/platform/people-list';
import { teamSummary } from '@/lib/shop-people';
```

Add the prop and the view state to `ShopDrawer`:

```ts
  /** Set when the roster read alone failed. The rest of the drawer is fine. */
  peopleError,
```

```ts
  // Which of the drawer's two screens is showing. The team is a VIEW inside
  // this modal, not a modal on top of it: two stacked sheets on a tablet leave
  // an operator dismissing an edge they cannot see -- the same call
  // platform/index.tsx already makes when it closes this drawer to open the
  // composer. Going back keeps the reason field, the plan chips and the scroll
  // position, which a second modal would not.
  const [view, setView] = useState<'store' | 'team'>('store');
```

Immediately after the `statusRow` view, add the People and branch sections, and wrap the existing body so the team view can replace it. The team view goes first as an early return:

```tsx
  if (view === 'team') {
    return (
      <View>
        <Pressable
          onPress={() => setView('store')}
          style={styles.backRow}
          aria-label={`Back to ${shop.shopName}`}
        >
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.teamScope}>
          {`${shop.people.length} of ${shop.limits.staff ?? '∞'} seats · signed up by the store, not by us`}
        </Text>
        <PeopleGroups people={shop.people} branchCount={shop.branches.length} />
        <Caveat tone="context">
          This is the store&apos;s own roster, as they set it up. We cannot add, remove, rename or deactivate anyone
          here.
        </Caveat>
      </View>
    );
  }
```

Then, in the store view, between the `statusRow` and the existing `ActionRow` that holds “Message this store”:

```tsx
      <SectionLabel>{`People · ${shop.people.length} of ${shop.limits.staff ?? '∞'} seats`}</SectionLabel>
      {peopleError ? (
        <Caveat tone="wrong">{`Could not load who works at this store: ${peopleError}. Everything else here is current.`}</Caveat>
      ) : shop.owner ? (
        <>
          <PersonRow
            person={shop.owner}
            branchCount={shop.branches.length}
            expanded={false}
            onToggle={() => setView('team')}
            first
          />
          {summary ? (
            <Pressable onPress={() => setView('team')} style={styles.teamRow} aria-label="Their team">
              <View style={styles.main}>
                <Text style={styles.teamTitle}>Their team</Text>
                <Text style={styles.teamLine} numberOfLines={1}>
                  {summary}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text style={styles.hint}>Nobody is recorded as working here yet.</Text>
      )}

      <SectionLabel>{`Where they trade · ${shop.branches.length} of ${shop.limits.locations ?? '∞'} branches`}</SectionLabel>
      {shop.branches.map((branch, i) => (
        <BranchRow key={branch.id} branch={branch} first={i === 0} />
      ))}
```

with `const summary = teamSummary(shop.people);` computed above the return.

Filter the two now-redundant rows out of the Usage list (currently `:96-108`) — the sections above say both, with names and places:

```tsx
      {LIMIT_RESOURCES.filter((r) => r.key !== 'staff' && r.key !== 'locations').map((r) => {
```

Add the styles:

```ts
  backRow: { paddingVertical: 6, marginBottom: 4 },
  back: { fontSize: 13, fontWeight: '800', color: theme.bentoMuted },
  teamScope: { fontSize: 11.5, color: theme.bentoMuted, marginBottom: 8 },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.bentoSoft,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 10,
  },
  main: { flex: 1, minWidth: 0 },
  teamTitle: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk },
  teamLine: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  chevron: { fontSize: 18, color: theme.bentoMuted2 },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/components/platform/__tests__/shop-drawer-people.test.tsx`
Expected: PASS — 11 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/components/platform/shop-drawer.tsx src/components/platform/__tests__/shop-drawer-people.test.tsx
git commit -m "feat(platform): the drawer opens on people, and the team is one tap inside the same sheet"
```

---

### Task 8: The Overview attention rows

**Files:**
- Modify: `src/components/platform-overview.tsx` (`AttentionRow` at `:377-413`, the `attention` list at `:203-228`)

**Interfaces:**
- Consumes: `WhatsAppButton`, `EmailButton` (Task 4); `contactPhone` (Task 2); `PlatformShopRow.owner` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Address the message to a person**

In `src/components/platform-overview.tsx`, replace the three `message` strings in the `attention` list so they greet the owner by their first name and fall back to the store's name:

```ts
  // Greets whoever we are actually writing to. `shop.owner` is null only when
  // the roster read failed, in which case this is the sentence it always was.
  const greet = (shop: PlatformShopRow) => shop.owner?.name.split(' ')[0] ?? shop.shopName;
```

```ts
      message: `Hi ${greet(shop)} — your Kaiibi trial ends soon. Would you like to keep going?`,
```
```ts
        message: `Hi ${greet(shop)} — you've reached your plan's limit on Kaiibi. Want to move up a tier?`,
```
```ts
      message: `Hi ${greet(shop)} — your Kaiibi plan has lapsed. Everything is still saved; shall we get you running again?`,
```

- [ ] **Step 2: Name the owner in the note, and swap the pill for the glyph**

Replace the body of `AttentionRow` (currently `:390-412`) with:

```tsx
  const phone = contactPhone(shop.owner, shop.branches);
  return (
    <View style={[styles.attentionRow, first && styles.attentionRowFirst]}>
      <Pressable style={styles.attentionMain} onPress={() => onOpen(shop.shopId)}>
        <Text style={styles.attentionName} numberOfLines={1}>
          {shop.shopName}
        </Text>
        <Text style={styles.attentionNote} numberOfLines={2}>
          {shop.owner ? `${note} · ${shop.owner.name}` : note}
        </Text>
      </Pressable>
      {/* Opens WhatsApp with the owner's own number and a first line already
          written, falling back to the number they print on their receipts. Six
          text pills reading "WhatsApp" down one card is six identical words;
          the glyph says it in a third of the width and reads as a button. */}
      <WhatsAppButton phone={phone} message={message} label={`WhatsApp ${shop.owner?.name ?? shop.shopName}`} />
      {!phone ? <EmailButton email={shop.owner?.email} label={`Email ${shop.owner?.name ?? shop.shopName}`} /> : null}
    </View>
  );
```

Add the import and delete the now-unused `waButton`, `waText`, `waMissing` styles and the `Linking` and `whatsappLink` imports if nothing else in the file uses them:

```ts
import { EmailButton, WhatsAppButton } from '@/components/platform/whatsapp-button';
import { contactPhone } from '@/lib/shop-people';
```

- [ ] **Step 3: Run the whole suite and the linter**

Run: `npx jest && npx tsc --noEmit && npx eslint src/lib/shop-people.ts src/lib/platform.ts src/components/platform src/components/platform-overview.tsx src/app/platform/index.tsx`
Expected: all tests pass, no type errors, no lint errors. `eslint` will flag any import left unused by Step 2 — remove it.

- [ ] **Step 4: Commit**

```bash
git add src/components/platform-overview.tsx
git commit -m "feat(platform): the attention list says who to call, and gives you one tap to do it"
```

---

### Task 9: See it running

**Files:** none — this task changes nothing. It exists because seven of the eight tasks above were verified against a test renderer, and a test renderer cannot tell you that a row wraps badly at 1024px or that a glyph is invisible on white.

- [ ] **Step 1: Start the app on web**

Run: `npx expo start --web`

- [ ] **Step 2: Walk the console**

Sign in as an operator (MFA required — `is_platform_admin()` demands `aal2`), then check each of these against `docs/design/store-people-contacts-mockup.html`:

1. **Stores tab** — every row names an owner and a city; the Contact column shows a green glyph and a number; a store with no owner phone shows "no number" rather than a dead button.
2. **Search** — type an owner's first name, then a city, then the last four digits of a number. Each finds the store.
3. **Drawer** — People section is above Usage; the owner is in full; "Their team" names two or three people; "Where they trade" lists every branch with its city; Usage has no Staff or Branches row.
4. **Team view** — tapping "Their team" swaps the sheet and shows a back arrow; each person carries a branch chip; tapping a person reveals email, phone and role permissions; going back leaves the reason field and plan chips exactly as they were.
5. **Overview** — attention rows name the owner and carry the glyph.

- [ ] **Step 3: Check the narrow layout**

Resize the browser below 900px (the `TABLET_BREAKPOINT`). The store cards stack, the contact glyph sits inside the card, and tapping the glyph does **not** open the drawer.

- [ ] **Step 4: Fix anything that reads wrong, then commit**

```bash
git add -A
git commit -m "fix(platform): what the running console showed that the tests could not"
```

---

## Notes for the implementer

**The one rule that is easy to get backwards:** an empty `branchNames` array means the person reaches **every** branch. It is asserted in `branchAccessLabel`'s tests, in the SQL verification script, and in the drawer's tests. If you find yourself writing `branchNames.length === 0 ? 'No branches'`, stop and re-read `can_access_location()`.

**One thing from the mockup that is deliberately NOT in this plan:** the owner's "also owns Hooyo Wholesale" line (mockup §7, "Two owners, one person"). It is free to compute — the console already holds every store — but only from a component that can see all of them, and `ShopDrawer` receives one store by design. Threading the whole list through to render one sentence is the wrong trade for a first pass. Ship the eight tasks, then add it as a one-line `alsoOwns: string[]` on `PlatformShopRow`, computed in `listPlatformShops` by grouping on `ownerId`.

**What this deliberately does not do:**
- No operator write path to any staff table. Not deactivating, not editing a role, not resetting a password. If we want that later it is a separate decision with its own audit-log entry.
- No `hire_date`, `pay_type`, `pay_rate_cents` or `photo_url` — not hidden in the UI, absent from the function.
- No claim about *who* signed a team member up. Nothing records it, and the write policy is `staff.manage`, which a Manager can hold — so the copy says "signed up by the store" and each row shows the date it can prove.

**If Task 1 cannot be verified locally** (no Docker, no Supabase CLI), do not fake it. Report that the migration is written but unverified, and let a human run the script against a real database before this branch merges.
