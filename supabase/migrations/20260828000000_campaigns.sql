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
grant select, insert on public.campaign_recipients to authenticated;

-- Only what the send queue genuinely changes -- state, opened_at, sent_at --
-- is grantable at the column level, matching 0017_roles_and_staff.sql's
-- profiles(full_name, phone) and 20260825000000's
-- support_threads(shop_read_at). Without this, `pos.access` (the RLS policy
-- above) is enough to reassign a sent row to a different campaign_id or
-- customer_id, rewriting the record of who was actually contacted.
grant update (state, opened_at, sent_at) on public.campaign_recipients to authenticated;

-- No delete grant. `skipped` and `unreachable` exist precisely so a row never
-- needs deleting to mean "didn't send", the audience top-up
-- (src/lib/campaign-audience.ts) only ever inserts, and a campaign's rows are
-- removed by `on delete cascade` when the campaign itself is deleted. There is
-- no legitimate path that deletes a single recipient row, and this table
-- exists to be an honest record of who was contacted -- deleting one is the
-- same integrity problem as rewriting it.

-- The module gate, matching every other billable table (20260818000400).
-- Campaigns are part of `promotions`; there is no separate entitlement.
-- Every other trigger built on enforce_shop_module() fires on `insert or
-- update`, never insert alone -- matched here rather than the insert-only
-- shape guessed when this migration was drafted.
create trigger campaigns_module before insert or update on public.campaigns
  for each row execute function public.enforce_shop_module('promotions');

-- Same, for a child table that reaches its shop through the campaign it
-- belongs to. campaign_recipients is one person's slot in a send queue and
-- carries no shop_id -- see the comment above its RLS policies. Without this,
-- everything that happens after a campaign is created (the audience top-up,
-- every state change the send queue makes) writes only to this table, and a
-- shop whose plan drops `promotions` mid-campaign could keep sending forever
-- because the gated table, campaigns, is never touched again.
create or replace function public.enforce_shop_module_via_campaign()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_module  text := TG_ARGV[0];
  v_shop_id uuid;
begin
  select c.shop_id into v_shop_id from public.campaigns c where c.id = new.campaign_id;
  if v_shop_id is not null and not public.shop_has_module(v_shop_id, v_module) then
    raise exception 'module_not_included'
      using errcode = 'P0001',
            detail = json_build_object('module', v_module)::text,
            hint = 'Upgrade the plan to make changes here.';
  end if;
  return new;
end;
$$;

create trigger campaign_recipients_module before insert or update on public.campaign_recipients
  for each row execute function public.enforce_shop_module_via_campaign('promotions');
