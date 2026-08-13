-- A promotion that runs itself.
--
-- 0013 gave promotions an `active` boolean and nothing else, so every
-- short-term offer -- a weekend, the three days before Eid, a Thursday
-- evening -- was a thing a human switched on and then had to remember to
-- switch off. The forgotten ones ran into the next month.
--
-- Three additions, deliberately three separate ideas:
--   starts_at/ends_at  scheduling. Null start = already running, null end =
--                      until someone switches it off (the current behaviour,
--                      still right for a standing loyalty discount).
--   auto_apply         false means the offer never fires by itself and only
--                      reaches a sale when a cashier picks it.
--   archived_at        gone from every list, kept only so old sales still
--                      read. NOT the same as active = false (paused, may come
--                      back) and NOT the same as an ended window (this run is
--                      over).
--
-- Every default preserves what existing rows already do.
alter table public.promotions
  add column starts_at   timestamptz,
  add column ends_at     timestamptz,
  add column auto_apply  boolean not null default true,
  add column archived_at timestamptz;

-- A window that closes before it opens would apply to nothing while reading
-- as scheduled, which is worse than being refused.
alter table public.promotions
  add constraint promotions_window_ordered
    check (starts_at is null or ends_at is null or ends_at > starts_at);

-- The POS filters on this on every cart line.
create index promotions_shop_live_idx
  on public.promotions (shop_id, active, archived_at, ends_at);
