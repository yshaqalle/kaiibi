# Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a shop pick one of its offers, pick who should hear about it, and send it to them on WhatsApp — one chat at a time, counting only what actually happened.

**Architecture:** Phase 3 of [`docs/superpowers/specs/2026-08-12-marketing-and-offers-design.md`](../specs/2026-08-12-marketing-and-offers-design.md). Two new tables. The audience is stored as a **filter**, not a frozen list, so fixing a phone number adds that customer to the queue. Sending goes through the `wa.me` deep link this app already uses, one recipient at a time, and the only thing the app can honestly record is a tap the owner made — so it asks, on return, whether it sent.

**Tech Stack:** Expo SDK 57 / React Native, TypeScript, Expo Router, Supabase (Postgres + RLS), Jest.

## Global Constraints

- **Expo docs:** Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code that touches an Expo API (`AGENTS.md`).
- **Never claim a delivery.** WhatsApp reports nothing back to a deep-linking app — not sent, not delivered, not read. Every number this feature shows must be either *a tap the owner made* or *a sale rung up under a customer's name*. A column, label or tile implying otherwise is a defect, not a wording choice.
- **Design for tens of recipients, with the sender swappable.** The one-tap queue is correct for ~30 people and painful for 300. The campaign, audience and message model must survive replacing the sender with the WhatsApp Cloud API without changing shape. Do not build the Cloud API.
- **Reachability uses `whatsappLink()` and nothing else.** `src/lib/whatsapp.ts` already decides whether a number can open a chat (it returns null under nine digits). A second opinion about phone numbers anywhere in this feature is a bug.
- **Segments come from `segmentForCustomer()`** in `src/lib/customer-segments.ts`, unchanged. No new segment concept and no schema field for one.
- **Migration ordering:** newest existing is `20260827000000`. Use `20260828000000`.
- **Both new tables are shop-scoped under `is_shop_member`**, matching `customers`, and gated on the existing `promotions` module. No new entitlement.
- **The Marketing tab is a bento screen** — `theme.bento*` from `Colors.light`. Never a hardcoded hex. No dark mode.
- **`AppState` has no precedent in this codebase** — `grep -rn AppState src/` returns nothing. Task 8 introduces it; treat that as new ground and comment it accordingly.
- **Tests:** `npm test`. Unit tests in `src/lib/__tests__/<name>.test.ts`. Jest pins `TZ=America/New_York`, so every date assertion must be timezone-independent.
- **Never `git add -A`** — a concurrent session may share this repository. Never push.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/campaign-audience.ts` | Who is in an audience, and who is reachable. Pure |
| `src/lib/campaign-message.ts` | Placeholder filling. Pure |
| `src/lib/campaign-metrics.ts` | The four numbers, each from a named source. Pure |
| `supabase/migrations/20260828000000_campaigns.sql` | `campaigns`, `campaign_recipients`, RLS, module gate |
| `src/lib/campaigns.ts` | CRUD, recipient materialisation and top-up, state transitions |
| `src/types/models.ts` | `Campaign`, `CampaignRecipient`, `AudienceFilter` |
| `src/components/marketing/campaigns-tab.tsx` | List + detail of campaigns |
| `src/components/marketing/campaign-composer.tsx` | The four-step create flow |
| `src/components/marketing/send-queue.tsx` | One recipient at a time, and the question on return |
| `src/components/marketing/marketing-tab.tsx` | The shell that now holds Campaigns and Promotions |
| `src/app/(admin)/(tabs)/people.tsx` | Points the Marketing tab at the new shell |

---

### Task 1: Who is in the audience

Pure logic. No database, no UI. This decides who gets messaged, so it goes first and is fully test-driven.

**Files:**
- Create: `src/lib/campaign-audience.ts`
- Test: `src/lib/__tests__/campaign-audience.test.ts`

**Interfaces:**
- Consumes: `segmentForCustomer` from `@/lib/customer-segments`, `whatsappLink` from `@/lib/whatsapp`, `Customer` from `@/types/models`.
- Produces:
  - `type AudienceFilter = { segments: CustomerSegment[]; tags: string[]; inactiveDays: number | null; locationId: string | null }`
  - `matchesAudience(customer: Customer, filter: AudienceFilter, lastPurchaseAt: string | null, now?: number): boolean`
  - `isReachable(customer: Customer): boolean`
  - `audienceSummary(customers, filter, lastPurchaseByCustomer, now?): { matched: number; reachable: number; unreachable: number }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/campaign-audience.test.ts`:

```ts
import { audienceSummary, isReachable, matchesAudience, type AudienceFilter } from '@/lib/campaign-audience';
import type { Customer } from '@/types/models';

const NOW = Date.parse('2026-08-13T10:00:00Z');

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'c1', shopId: 's1', firstName: 'Hodan', lastName: 'Ali', email: null,
    phone: '063 771 4402', street: null, city: null, neighborhood: null,
    tags: [], notes: null, pointsBalance: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Customer;
}

const EMPTY: AudienceFilter = { segments: [], tags: [], inactiveDays: null, locationId: null };

describe('isReachable', () => {
  it('is true for a number WhatsApp can open', () => {
    expect(isReachable(makeCustomer({ phone: '063 771 4402' }))).toBe(true);
  });

  it('is false with no phone at all', () => {
    expect(isReachable(makeCustomer({ phone: null }))).toBe(false);
  });

  it('is false for a number too short to dial', () => {
    expect(isReachable(makeCustomer({ phone: '1234' }))).toBe(false);
  });
});

describe('matchesAudience', () => {
  it('an empty filter matches everyone', () => {
    expect(matchesAudience(makeCustomer(), EMPTY, null, NOW)).toBe(true);
  });

  it('matches a chosen segment', () => {
    const vip = makeCustomer({ tags: ['vip'] });
    const filter = { ...EMPTY, segments: ['vip' as const] };
    expect(matchesAudience(vip, filter, null, NOW)).toBe(true);
  });

  it('excludes a customer outside every chosen segment', () => {
    const plain = makeCustomer({ tags: [], createdAt: '2020-01-01T00:00:00Z' });
    const filter = { ...EMPTY, segments: ['vip' as const] };
    expect(matchesAudience(plain, filter, null, NOW)).toBe(false);
  });

  it('matches any one of several chosen segments', () => {
    const atRisk = makeCustomer({ tags: ['at risk'] });
    const filter = { ...EMPTY, segments: ['vip' as const, 'at-risk' as const] };
    expect(matchesAudience(atRisk, filter, null, NOW)).toBe(true);
  });

  it('matches a tag regardless of case', () => {
    const c = makeCustomer({ tags: ['Wholesale'] });
    expect(matchesAudience(c, { ...EMPTY, tags: ['wholesale'] }, null, NOW)).toBe(true);
  });

  it('requires every chosen tag, not just one', () => {
    const c = makeCustomer({ tags: ['wholesale'] });
    expect(matchesAudience(c, { ...EMPTY, tags: ['wholesale', 'credit'] }, null, NOW)).toBe(false);
  });

  it('includes someone whose last purchase is older than the inactive window', () => {
    const filter = { ...EMPTY, inactiveDays: 60 };
    const longAgo = '2026-01-01T00:00:00Z';
    expect(matchesAudience(makeCustomer(), filter, longAgo, NOW)).toBe(true);
  });

  it('excludes someone who bought inside the inactive window', () => {
    const filter = { ...EMPTY, inactiveDays: 60 };
    const recent = '2026-08-10T00:00:00Z';
    expect(matchesAudience(makeCustomer(), filter, recent, NOW)).toBe(false);
  });

  it('includes someone who has never bought when an inactive window is set', () => {
    // Never having bought is the strongest form of "has not bought lately".
    const filter = { ...EMPTY, inactiveDays: 60 };
    expect(matchesAudience(makeCustomer(), filter, null, NOW)).toBe(true);
  });

  it('an unreachable customer still MATCHES — reachability is a separate question', () => {
    // They stay in the audience so that fixing their phone number later adds
    // them to the queue rather than requiring the campaign be rebuilt.
    const noPhone = makeCustomer({ phone: null });
    expect(matchesAudience(noPhone, EMPTY, null, NOW)).toBe(true);
    expect(isReachable(noPhone)).toBe(false);
  });
});

describe('audienceSummary', () => {
  it('counts matched, reachable and unreachable separately', () => {
    const customers = [
      makeCustomer({ id: 'a', phone: '063 771 4402' }),
      makeCustomer({ id: 'b', phone: null }),
      makeCustomer({ id: 'c', phone: '063 771 4403' }),
    ];
    const summary = audienceSummary(customers, EMPTY, new Map(), NOW);
    expect(summary).toEqual({ matched: 3, reachable: 2, unreachable: 1 });
  });

  it('counts only those the filter matched', () => {
    const customers = [
      makeCustomer({ id: 'a', tags: ['vip'] }),
      makeCustomer({ id: 'b', tags: [], createdAt: '2020-01-01T00:00:00Z' }),
    ];
    const summary = audienceSummary(customers, { ...EMPTY, segments: ['vip'] }, new Map(), NOW);
    expect(summary).toEqual({ matched: 1, reachable: 1, unreachable: 0 });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/lib/__tests__/campaign-audience.test.ts`
Expected: FAIL — `Cannot find module '@/lib/campaign-audience'`.

- [ ] **Step 3: Implement**

Create `src/lib/campaign-audience.ts`:

```ts
import { segmentForCustomer, type CustomerSegment } from '@/lib/customer-segments';
import { whatsappLink } from '@/lib/whatsapp';
import type { Customer } from '@/types/models';

// Who a campaign is for, stored on the campaign as jsonb.
//
// A FILTER, not a list of ids, and that is the whole design: a customer whose
// phone number is corrected next week should join the queue on their own,
// without anyone rebuilding the campaign. Freezing the list at creation would
// make "fix a number and they get the message" impossible to honour.
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

// Whether a chat can be opened at all, asked of the one function that already
// decides this for the WhatsApp button (src/lib/whatsapp.ts). A second opinion
// about what a phone number is would eventually disagree with the button, and
// the count on screen would stop matching what the buttons can do.
export function isReachable(customer: Customer): boolean {
  return whatsappLink(customer.phone) !== null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Deliberately independent of isReachable: someone with no usable number is
// still IN the audience. They show as unreachable and they join the send queue
// the moment their number is fixed.
export function matchesAudience(
  customer: Customer,
  filter: AudienceFilter,
  lastPurchaseAt: string | null,
  now: number = Date.now()
): boolean {
  if (filter.segments.length > 0 && !filter.segments.includes(segmentForCustomer(customer))) {
    return false;
  }

  // Every chosen tag, not any: picking "wholesale" and "credit" means the
  // customers who are both, which is what a person selecting two labels means.
  if (filter.tags.length > 0) {
    const owned = customer.tags.map((t) => t.toLowerCase());
    if (!filter.tags.every((t) => owned.includes(t.toLowerCase()))) return false;
  }

  if (filter.inactiveDays !== null) {
    // Never having bought is the strongest form of "has not bought lately",
    // so a null last purchase passes rather than being excluded for lack of
    // data -- these are exactly the people a win-back campaign is for.
    if (lastPurchaseAt !== null && now - Date.parse(lastPurchaseAt) < filter.inactiveDays * DAY_MS) {
      return false;
    }
  }

  return true;
}

export function audienceSummary(
  customers: readonly Customer[],
  filter: AudienceFilter,
  lastPurchaseByCustomer: ReadonlyMap<string, string>,
  now: number = Date.now()
): { matched: number; reachable: number; unreachable: number } {
  let matched = 0;
  let reachable = 0;
  for (const customer of customers) {
    if (!matchesAudience(customer, filter, lastPurchaseByCustomer.get(customer.id) ?? null, now)) continue;
    matched++;
    if (isReachable(customer)) reachable++;
  }
  return { matched, reachable, unreachable: matched - reachable };
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx jest src/lib/__tests__/campaign-audience.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` → no errors. Run: `npm test` → PASS.

```bash
git add src/lib/campaign-audience.ts src/lib/__tests__/campaign-audience.test.ts
git commit -m "feat(campaigns): an audience is a filter, so a fixed number joins it"
```

---

### Task 2: What the message says

**Files:**
- Create: `src/lib/campaign-message.ts`
- Test: `src/lib/__tests__/campaign-message.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MessageValues = { name: string; shop: string; offer: string; ends: string; branch: string }`
  - `PLACEHOLDERS: readonly string[]` — `['{name}', '{shop}', '{offer}', '{ends}', '{branch}']`
  - `fillMessage(template: string, values: MessageValues): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/campaign-message.test.ts`:

```ts
import { fillMessage, PLACEHOLDERS, type MessageValues } from '@/lib/campaign-message';

const VALUES: MessageValues = {
  name: 'Hodan',
  shop: 'Suuqa Xamar',
  offer: '20% off everything',
  ends: 'Saturday',
  branch: 'Xamar branch',
};

describe('fillMessage', () => {
  it('replaces every placeholder it knows', () => {
    const out = fillMessage('Hi {name} — {offer} at {shop} until {ends}. {branch}.', VALUES);
    expect(out).toBe('Hi Hodan — 20% off everything at Suuqa Xamar until Saturday. Xamar branch.');
  });

  it('replaces a placeholder used more than once', () => {
    expect(fillMessage('{name}, yes {name}', VALUES)).toBe('Hodan, yes Hodan');
  });

  it('leaves text with no placeholders alone', () => {
    expect(fillMessage('Just a plain message', VALUES)).toBe('Just a plain message');
  });

  it('leaves an unknown placeholder exactly as written', () => {
    // Better a visible {total} in the draft than a silently empty gap the
    // owner only notices after sending.
    expect(fillMessage('Hi {name}, you owe {total}', VALUES)).toBe('Hi Hodan, you owe {total}');
  });

  it('does not re-expand a value that itself looks like a placeholder', () => {
    // A shop literally named "{name}" must not turn into the customer's name.
    const out = fillMessage('{shop} says hi to {name}', { ...VALUES, shop: '{name}' });
    expect(out).toBe('{name} says hi to Hodan');
  });

  it('substitutes an empty string for a value that is empty', () => {
    expect(fillMessage('Ends {ends}', { ...VALUES, ends: '' })).toBe('Ends ');
  });

  it('exposes the placeholder list the composer offers', () => {
    expect(PLACEHOLDERS).toEqual(['{name}', '{shop}', '{offer}', '{ends}', '{branch}']);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/lib/__tests__/campaign-message.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/campaign-message.ts`:

```ts
// One message, written once, addressed per person.
//
// The owner writes "Hi {name} — {offer} at {shop} until {ends}" and every chat
// opens with that customer's own name already in it. The placeholders are a
// fixed set rather than free-form templating: this text is going to a customer
// over WhatsApp, and an expression language would be a way to send something
// nobody proof-read.
export type MessageValues = {
  name: string;
  shop: string;
  offer: string;
  ends: string;
  branch: string;
};

export const PLACEHOLDERS = ['{name}', '{shop}', '{offer}', '{ends}', '{branch}'] as const;

// A single left-to-right pass, NOT five sequential replaces.
//
// Sequential replacement would re-expand its own output: a shop named "{name}"
// would become the customer's name on the following pass. One pass over the
// original string cannot do that, because nothing it writes is ever read again.
export function fillMessage(template: string, values: MessageValues): string {
  return template.replace(/\{(name|shop|offer|ends|branch)\}/g, (match, key: keyof MessageValues) => {
    const value = values[key];
    // An unknown placeholder never reaches here (the pattern only matches the
    // five), and is therefore left visible in the draft rather than silently
    // blanked -- an owner can see and fix "{total}", but not a gap.
    return value ?? match;
  });
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx jest src/lib/__tests__/campaign-message.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` → no errors. Run: `npm test` → PASS.

```bash
git add src/lib/campaign-message.ts src/lib/__tests__/campaign-message.test.ts
git commit -m "feat(campaigns): one message, addressed to each person"
```

---

### Task 3: The tables

**Files:**
- Create: `supabase/migrations/20260828000000_campaigns.sql`
- Create: `supabase/tests/verify-campaigns.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.campaigns`, `public.campaign_recipients`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260828000000_campaigns.sql`:

```sql
-- Telling customers an offer exists.
--
-- Promotions have applied themselves at the till since 0013, and since
-- 20260826000000 they know when they run -- but nothing has ever told a
-- customer they existed. A campaign is that missing half: one offer, one
-- audience, one message, and a record of who was actually contacted.
create table public.campaigns (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  -- Null is allowed and means "a message with no discount behind it" -- new
  -- stock, a change of hours, a thank you. `on delete set null` rather than
  -- cascade: deleting an offer must not delete the record of having told
  -- people about it.
  promotion_id uuid references public.promotions(id) on delete set null,
  name         text not null,
  -- Two languages, two columns, ONE campaign. Somali and English drafts of the
  -- same message are not two campaigns -- they share an audience and a queue,
  -- and splitting them would double every count on the screen.
  message_en   text,
  message_so   text,
  -- The AudienceFilter from src/lib/campaign-audience.ts. Stored as a filter
  -- rather than a list of customer ids so that fixing someone's phone number
  -- adds them to the queue instead of requiring the campaign be rebuilt.
  audience     jsonb not null default '{}'::jsonb,
  status       text not null default 'draft' check (status in ('draft', 'sending', 'done')),
  created_at   timestamptz not null default now(),
  started_at   timestamptz
);
create index campaigns_shop_id_idx on public.campaigns (shop_id, created_at desc);

-- One row per person this campaign has actually reached for.
--
-- The states are deliberately weaker than they could be, because WhatsApp
-- tells a deep-linking app nothing -- not sent, not delivered, not read:
--   waiting      materialised, not yet opened
--   opened       we called openWhatsApp(). A record of OUR tap, nothing more
--   sent         the OWNER answered "yes, sent" when the app came back
--   skipped      the owner passed on this person
--   unreachable  no number WhatsApp can open, or the owner said so
--
-- There is no 'delivered' and no 'read', and there must never be one on this
-- path. Only the Cloud API returns those.
create table public.campaign_recipients (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  state       text not null default 'waiting'
                check (state in ('waiting', 'opened', 'sent', 'skipped', 'unreachable')),
  opened_at   timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  -- What makes the top-up idempotent: re-evaluating the audience filter every
  -- time the queue opens can insert freely, and nobody is queued twice.
  unique (campaign_id, customer_id)
);
create index campaign_recipients_campaign_idx on public.campaign_recipients (campaign_id, state);

alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;

-- Same shape as customers (0023): any shop member reads, and writing needs the
-- permission the Marketing screen itself is gated on. Reading is deliberately
-- wider than writing -- a cashier running the send queue needs the rows.
create policy "read campaigns" on public.campaigns for select using (public.is_shop_member(shop_id));
create policy "write campaigns" on public.campaigns for all
  using (public.has_shop_permission(shop_id, 'settings.access'))
  with check (public.has_shop_permission(shop_id, 'settings.access'));

-- Recipients inherit their campaign's shop rather than carrying a shop_id of
-- their own: a denormalised copy could disagree with the campaign it belongs
-- to, and there is no situation where the two should differ.
create policy "read campaign_recipients" on public.campaign_recipients for select
  using (exists (select 1 from public.campaigns c where c.id = campaign_id and public.is_shop_member(c.shop_id)));
-- Updating a recipient's state is what the send queue does all day, and a
-- cashier working the queue holds pos.access, not settings.access.
create policy "write campaign_recipients" on public.campaign_recipients for all
  using (exists (select 1 from public.campaigns c where c.id = campaign_id
                   and public.has_any_shop_permission(c.shop_id, array['settings.access', 'pos.access'])))
  with check (exists (select 1 from public.campaigns c where c.id = campaign_id
                   and public.has_any_shop_permission(c.shop_id, array['settings.access', 'pos.access'])));

grant select, insert, update, delete on public.campaigns to authenticated;
grant select, insert, update, delete on public.campaign_recipients to authenticated;

-- The module gate, matching every other billable table (20260818000400).
-- Campaigns are part of `promotions`; there is no separate entitlement.
create trigger campaigns_module before insert on public.campaigns
  for each row execute function public.enforce_shop_module('promotions');
```

**Before writing the trigger line, check how `enforce_shop_module` is actually invoked** in `supabase/migrations/20260818000400_module_write_gates.sql` — copy its exact trigger signature and argument style rather than the shape guessed above, and adjust if it differs.

- [ ] **Step 2: Apply locally and verify**

**Never run `npx supabase db push`** — this repo is linked to a live project. Local only:

Run: `npx supabase migration up --local`
Expected: applies with no error.

Create `supabase/tests/verify-campaigns.sql`:

```sql
-- Verification for 20260828000000. Run against the local database.
-- Every block prints PASS or FAIL.

-- 1. A recipient cannot be queued twice for the same campaign.
do $$
declare v_shop uuid; v_campaign uuid; v_customer uuid;
begin
  select id into v_shop from public.shops limit 1;
  insert into public.campaigns (shop_id, name) values (v_shop, 'dup test') returning id into v_campaign;
  select id into v_customer from public.customers where shop_id = v_shop limit 1;
  if v_customer is null then
    insert into public.customers (shop_id, first_name) values (v_shop, 'Dup Test') returning id into v_customer;
  end if;
  insert into public.campaign_recipients (campaign_id, customer_id) values (v_campaign, v_customer);
  begin
    insert into public.campaign_recipients (campaign_id, customer_id) values (v_campaign, v_customer);
    raise notice 'FAIL: the same customer was queued twice';
  exception when unique_violation then
    raise notice 'PASS: a duplicate recipient was refused';
  end;
  delete from public.campaigns where id = v_campaign;
end $$;

-- 2. No state anywhere claims a delivery.
select case when count(*) = 0 then 'PASS: no delivered/read state exists'
            else 'FAIL: a delivery-claiming state is allowed' end
from pg_constraint
where conname like 'campaign_recipients_state%'
  and (pg_get_constraintdef(oid) ilike '%delivered%' or pg_get_constraintdef(oid) ilike '%read%');

-- 3. Deleting a promotion keeps the campaign that advertised it.
do $$
declare v_shop uuid; v_promo uuid; v_campaign uuid; v_left integer;
begin
  select id into v_shop from public.shops limit 1;
  insert into public.promotions (shop_id, name, discount_type, discount_value, scope)
    values (v_shop, 'temp promo', 'percentage', 10, 'store') returning id into v_promo;
  insert into public.campaigns (shop_id, promotion_id, name)
    values (v_shop, v_promo, 'keeps its history') returning id into v_campaign;
  delete from public.promotions where id = v_promo;
  select count(*) into v_left from public.campaigns where id = v_campaign;
  if v_left = 1 then raise notice 'PASS: the campaign outlived its promotion';
  else raise notice 'FAIL: deleting a promotion destroyed the campaign';
  end if;
  delete from public.campaigns where id = v_campaign;
end $$;
```

Run it and read the notices:
`psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/verify-campaigns.sql`
Expected: three PASS lines.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260828000000_campaigns.sql supabase/tests/verify-campaigns.sql
git commit -m "feat(campaigns): two tables, and no state that claims a delivery"
```

---

### Task 4: Reading and writing campaigns

**Files:**
- Modify: `src/types/models.ts`
- Create: `src/lib/campaigns.ts`

**Interfaces:**
- Consumes: `AudienceFilter` from Task 1.
- Produces:
  - `type Campaign = { id; shopId; promotionId: string | null; name; messageEn: string | null; messageSo: string | null; audience: AudienceFilter; status: 'draft' | 'sending' | 'done'; createdAt; startedAt: string | null }`
  - `type RecipientState = 'waiting' | 'opened' | 'sent' | 'skipped' | 'unreachable'`
  - `type CampaignRecipient = { id; campaignId; customerId; state: RecipientState; openedAt: string | null; sentAt: string | null }`
  - `listCampaigns(shopId): Promise<Campaign[]>`
  - `createCampaign(shopId, input): Promise<Campaign>`
  - `updateCampaign(id, patch): Promise<Campaign>`
  - `deleteCampaign(id): Promise<void>`
  - `listRecipients(campaignId): Promise<CampaignRecipient[]>`
  - `syncRecipients(campaignId, customerIds: string[]): Promise<number>` — inserts the missing ones, returns how many were added
  - `setRecipientState(id, state: RecipientState): Promise<void>`

- [ ] **Step 1: Add the types**

In `src/types/models.ts`, after the `Promotion` type:

```ts
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
```

Import `AudienceFilter` at the top of `models.ts` from `@/lib/campaign-audience`. If that creates a circular import (models importing from lib while lib imports models), instead **move the `AudienceFilter` type into `models.ts`** and have `campaign-audience.ts` import it from there — check which direction the file already depends on before choosing, and keep the dependency one-way.

- [ ] **Step 2: Write the client**

Create `src/lib/campaigns.ts`, following the exact shape of `src/lib/promotions.ts` — a `mapRow` function, one exported call per operation, `if (error) throw error`. Include:

```ts
// Adds the audience's customers who are not already queued, and returns how
// many were added.
//
// Called every time the queue is opened, not only when sending starts. That is
// what makes "fix a phone number and they join the queue" true rather than
// aspirational: the filter is re-evaluated, anyone newly matching is inserted,
// and the unique (campaign_id, customer_id) constraint makes running it
// repeatedly harmless.
//
// Removal is deliberately NOT symmetric. A customer who stops matching the
// filter mid-campaign keeps their row: deleting people from a queue the owner
// is halfway through would silently move the denominator they are working
// against.
export async function syncRecipients(campaignId: string, customerIds: string[]): Promise<number> {
  if (customerIds.length === 0) return 0;
  const { data, error } = await supabase
    .from('campaign_recipients')
    .upsert(
      customerIds.map((customerId) => ({ campaign_id: campaignId, customer_id: customerId })),
      { onConflict: 'campaign_id,customer_id', ignoreDuplicates: true }
    )
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit` → no errors. Run: `npm test` → PASS.

```bash
git add src/types/models.ts src/lib/campaigns.ts
git commit -m "feat(campaigns): the client, and a top-up that cannot double-queue"
```

---

### Task 5: The four numbers

**Files:**
- Create: `src/lib/campaign-metrics.ts`
- Test: `src/lib/__tests__/campaign-metrics.test.ts`

**Interfaces:**
- Consumes: `CampaignRecipient`, `RecipientState` from Task 4.
- Produces:
  - `countRecipients(recipients: readonly CampaignRecipient[]): { audience: number; markedSent: number; opened: number; skipped: number; unreachable: number }`
  - `boughtWithin(recipients: readonly CampaignRecipient[], salesByCustomer: ReadonlyMap<string, readonly string[]>, windowDays: number, now?: number): number`

Note there is no `reachable` here: reachability is a property of a customer's phone number, answered by `isReachable` in Task 1, not of a recipient row. Counting it in two places would let the two disagree.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/campaign-metrics.test.ts`:

```ts
import { boughtWithin, countRecipients } from '@/lib/campaign-metrics';
import type { CampaignRecipient, RecipientState } from '@/types/models';

const NOW = Date.parse('2026-08-13T10:00:00Z');

function r(state: RecipientState, overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    id: Math.random().toString(36), campaignId: 'k1', customerId: 'c1',
    state, openedAt: null, sentAt: null, ...overrides,
  };
}

describe('countRecipients', () => {
  it('counts each state separately', () => {
    const counts = countRecipients([
      r('sent'), r('sent'), r('opened'), r('waiting'), r('skipped'), r('unreachable'),
    ]);
    expect(counts).toEqual({ audience: 6, markedSent: 2, opened: 1, skipped: 1, unreachable: 1 });
  });

  it('does not count an opened chat as sent — that is the whole point', () => {
    const counts = countRecipients([r('opened'), r('opened')]);
    expect(counts.markedSent).toBe(0);
    expect(counts.opened).toBe(2);
  });

  it('handles an empty campaign', () => {
    expect(countRecipients([])).toEqual({ audience: 0, markedSent: 0, opened: 0, skipped: 0, unreachable: 0 });
  });
});

describe('boughtWithin', () => {
  it('counts a recipient who bought after being sent to, inside the window', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(1);
  });

  it('does not count a sale that happened BEFORE the message', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-01T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(0);
  });

  it('does not count a sale outside the window', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-07-01T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-07-20T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(0);
  });

  it('counts a customer once however many times they bought', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z', '2026-08-12T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(1);
  });

  it('ignores a recipient who was never marked sent', () => {
    // Nothing was claimed to have reached them, so a sale proves nothing here.
    const recipients = [r('opened', { customerId: 'c1', sentAt: null })];
    const sales = new Map([['c1', ['2026-08-11T10:00:00Z']]]);
    expect(boughtWithin(recipients, sales, 7, NOW)).toBe(0);
  });

  it('ignores a customer with no sales at all', () => {
    const recipients = [r('sent', { customerId: 'c1', sentAt: '2026-08-10T10:00:00Z' })];
    expect(boughtWithin(recipients, new Map(), 7, NOW)).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx jest src/lib/__tests__/campaign-metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/campaign-metrics.ts`:

```ts
import type { CampaignRecipient } from '@/types/models';

// Every figure a campaign shows, and where each one comes from.
//
// The tempting metric here is "opened", meaning the CUSTOMER opened it, and it
// is unavailable: a wa.me link is a one-way door with no callback and no
// return value. So this file counts two kinds of thing and nothing else --
// a tap the owner made, and a sale rung up under a customer's name.

export function countRecipients(recipients: readonly CampaignRecipient[]) {
  const counts = { audience: recipients.length, markedSent: 0, opened: 0, skipped: 0, unreachable: 0 };
  for (const recipient of recipients) {
    if (recipient.state === 'sent') counts.markedSent++;
    // 'opened' is strictly weaker than 'sent': the app handed the chat over
    // with the text written, and the owner never confirmed what happened next.
    else if (recipient.state === 'opened') counts.opened++;
    else if (recipient.state === 'skipped') counts.skipped++;
    else if (recipient.state === 'unreachable') counts.unreachable++;
  }
  return counts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Recipients who bought within `windowDays` of being messaged.
//
// The strongest number this feature has, because it never touches WhatsApp:
// it is a sale in this shop's own books, attached to a customer at the till.
// It is still a CORRELATION -- they may have been coming anyway, and a
// walk-in gets the same discount -- and the tile showing it must say so.
//
// Only 'sent' recipients count. For anyone else nothing was claimed to have
// reached them, so a purchase says nothing about the campaign.
export function boughtWithin(
  recipients: readonly CampaignRecipient[],
  salesByCustomer: ReadonlyMap<string, readonly string[]>,
  windowDays: number,
  now: number = Date.now()
): number {
  let count = 0;
  for (const recipient of recipients) {
    if (recipient.state !== 'sent' || !recipient.sentAt) continue;
    const sentAt = Date.parse(recipient.sentAt);
    const sales = salesByCustomer.get(recipient.customerId) ?? [];
    // `some`, not a tally: a customer who came back four times is one person
    // who responded, and counting visits would let one enthusiast look like
    // four.
    const responded = sales.some((iso) => {
      const at = Date.parse(iso);
      return at >= sentAt && at - sentAt <= windowDays * DAY_MS;
    });
    if (responded) count++;
  }
  return count;
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `npx jest src/lib/__tests__/campaign-metrics.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` → no errors. Run: `npm test` → PASS.

```bash
git add src/lib/campaign-metrics.ts src/lib/__tests__/campaign-metrics.test.ts
git commit -m "feat(campaigns): count a tap we made and a sale we rang up, nothing else"
```

---

### Task 6: The Marketing shell holds two things now

**Files:**
- Create: `src/components/marketing/marketing-tab.tsx`
- Modify: `src/app/(admin)/(tabs)/people.tsx`
- Modify: `src/components/marketing/promotions-tab.tsx` (export only; do not restructure it)

**Interfaces:**
- Produces: `<MarketingTab compact setHeaderActions setDetailSelected />`, the same prop shape `PromotionsTab` already takes.

- [ ] **Step 1: Build the shell**

Marketing currently renders `PromotionsTab` directly. It now holds two sections — **Campaigns** and **Offers** — with campaigns first, matching `docs/design/marketing-mockup.html`'s header (a "Promotions" pill beside a solid "New campaign").

Read `src/app/(admin)/(tabs)/people.tsx` for how it switches between its own tabs and reuse that pattern rather than inventing a second one. The section choice lives in the shell, so switching sections must not remount the other one's state.

`people.tsx` renders `<MarketingTab …>` where it currently renders `<PromotionsTab …>`. Everything else in that file — the gate, the blurb, the deep link — stays exactly as it is.

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit` → clean. Run: `npm test` → PASS.

```bash
git add src/components/marketing/marketing-tab.tsx "src/app/(admin)/(tabs)/people.tsx" src/components/marketing/promotions-tab.tsx
git commit -m "feat(marketing): the tab makes room for campaigns"
```

---

### Task 7: The campaign list and its detail

**Files:**
- Create: `src/components/marketing/campaigns-tab.tsx`

**Interfaces:**
- Consumes: `listCampaigns`, `listRecipients` (Task 4); `countRecipients`, `boughtWithin` (Task 5).

- [ ] **Step 1: Build it**

`TwoPaneListDetail`, the same component Customers, Team and Promotions already use. Read `promotions-tab.tsx` and match it.

The list row shows the campaign name, its audience in words, and a status chip — Draft / Sending 31 of 84 / Done.

The detail pane shows, per the mockup:
- the offer behind it, or "no discount" when `promotionId` is null
- the message as it will read, with placeholders filled from a sample recipient
- **five stat tiles**, each labelled with what it actually is: Audience, Reachable, Marked sent, Chats opened, Bought within 7 days
- a `Caveat tone="context"` under the last tile saying it is what the till recorded, not proof the message caused it
- a `Caveat tone="wrong"` **with an action** when anyone in the audience is unreachable, linking to those customers so their numbers can be fixed
- a primary control: **Continue sending · N left**

Every tile label must survive the question "could a reader think this means WhatsApp confirmed something?" If yes, rename it.

- [ ] **Step 2: Verify and commit**

Run: `npx tsc --noEmit` → clean. Run: `npm test` → PASS.

```bash
git add src/components/marketing/campaigns-tab.tsx
git commit -m "feat(campaigns): a list, a detail, and numbers that name their source"
```

---

### Task 8: The send queue

The heart of the feature, and the one place a new platform API appears.

**Files:**
- Create: `src/components/marketing/send-queue.tsx`

**Interfaces:**
- Consumes: `openWhatsApp` from `@/lib/whatsapp`; `fillMessage` (Task 2); `setRecipientState`, `syncRecipients`, `listRecipients` (Task 4).

- [ ] **Step 1: Read the Expo/React Native docs first**

`AppState` has no precedent in this codebase (`grep -rn AppState src/` returns nothing). Read https://reactnative.dev/docs/appstate before writing against it. What matters: the listener fires on background→active transitions, and the subscription must be removed on unmount or every reopened queue adds another.

- [ ] **Step 2: Build it**

One recipient at a time:

- the current person: name, phone, segment, last purchase
- a primary button, **Open WhatsApp for {name}**, calling the existing `openWhatsApp(phone, message)` — do not build a second link builder
- on tap, set that recipient to `opened` **before** leaving the app, since the app is about to lose the foreground
- secondary: **Skip this person**, **Not reachable**
- the queue below, showing each recipient's state honestly: `sent 11:04`, `chat opened — send?`, `skipped`, `no usable number`

**On return to foreground**, ask once about the recipient whose chat was just opened: *"Did that send to {name}?"* → **Yes, sent** / **No — try again later**. Yes sets `sent` with `sentAt`; No returns them to `waiting`. Ignoring it leaves them `opened`, which is true and visibly weaker than sent.

**Pacing.** After every 20 marked sent, show a `Caveat tone="context"` suggesting a break: WhatsApp rate-limits and can ban numbers that message dozens of non-contacts in a burst. This is a real constraint on the shop's own phone number, not decoration. It advises; it must not block.

**Top up on open.** When the queue mounts, re-evaluate the audience and `syncRecipients` before rendering, so a customer whose number was fixed appears. If any were added, say so — "3 more customers can be reached now".

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit` → clean. Run: `npm test` → PASS.

```bash
git add src/components/marketing/send-queue.tsx
git commit -m "feat(campaigns): one chat at a time, and one honest question after"
```

---

### Task 9: The composer

**Files:**
- Create: `src/components/marketing/campaign-composer.tsx`

**Interfaces:**
- Consumes: `audienceSummary`, `AudienceFilter` (Task 1); `PLACEHOLDERS`, `fillMessage` (Task 2); `createCampaign` (Task 4).

- [ ] **Step 1: Build it**

Four steps, numbered because they genuinely are a sequence:

1. **What is the offer?** — the shop's live promotions as choices, plus "Just a message, no discount". Only offers inside their window are offered; an expired one advertises nothing.
2. **Who gets it?** — segment chips with live counts, tag chips, and "has not bought in N days". A running line reads **"84 reachable of 96"**, recomputed as the filter changes via `audienceSummary`. A `Caveat tone="partial"` explains the gap: those customers stay in the audience and join the queue when a number is fixed.
3. **What does it say?** — the message with a placeholder row (`PLACEHOLDERS`, tap to insert), an English and a Somali field, and a live preview of the filled text for a real customer from the audience.
4. **How does it go out?** — "One chat at a time" selected, with the honest cost stated: about five seconds each, roughly seven minutes for 84 people. Beside it, "Send them all at once" **disabled**, labelled *Not connected*, explaining it needs a WhatsApp Business account, a dedicated number and Meta's approval of the wording. Do not build it; do not hide that it exists.

Footer: **Save as draft** and **Start sending · N**.

**Start sending must be disabled when N is zero**, with a line saying why — either nobody matches the filter, or everyone who does is unreachable. Those are different problems with different fixes (widen the audience vs. fix some phone numbers), so say which one it is rather than showing a dead button. This is a spec acceptance criterion, not a nicety.

- [ ] **Step 2: Verify on device — required**

Run the app and confirm with screenshots:

1. Creating a campaign for a segment produces exactly the recipients the composer's count promised.
2. A customer with no phone number is in the audience, counted as unreachable, and absent from the queue.
3. Giving that customer a valid number and reopening the queue adds them, with the count line saying so.
4. Opening a chat sets `opened`; answering "Yes, sent" sets `sent`; ignoring the question leaves `opened`.
5. The message arrives in WhatsApp with the customer's real name, not `{name}`.

Use the project's `/testing-kaiibi` skill.

- [ ] **Step 3: Commit**

```bash
git add src/components/marketing/campaign-composer.tsx
git commit -m "feat(campaigns): pick an offer, pick who hears about it, write it once"
```

---

## Definition of done

- [ ] An audience is a filter: fixing a phone number adds that customer to an in-progress queue.
- [ ] Nobody is queued twice, however many times the top-up runs.
- [ ] No screen, column or label claims a delivery. `opened` and `sent` are visibly different things.
- [ ] "Bought within 7 days" counts only recipients marked sent, counts each person once, and carries its caveat.
- [ ] A campaign survives its promotion being deleted.
- [ ] The queue resumes where it left off after the app is closed and reopened.
- [ ] Editing a message mid-campaign leaves already-sent recipients alone.

## Out of scope

The WhatsApp Business Cloud API · scheduled or recurring campaigns · A/B testing · email or SMS · replies (nothing comes back on this path) · per-recipient message editing · the till-side redemption prompt, which is Phase 4.
