-- When a shop is open. The schema had no concept of it: shops carried a name,
-- city, neighborhood, phone and return policy, so a receipt couldn't print
-- hours and team scheduling had nothing to validate a shift against.
--
-- One JSONB column rather than a table of seven rows per shop: the entries are
-- always read and written together, never queried across shops and never
-- joined, so a table would buy nothing and cost a join on every receipt.
--
-- Shape: { "mon": [{"open":"09:00","close":"18:00"}], "sun": [] }
-- Times are local wall-clock strings, NOT timestamps -- a shop that opens at
-- 9am opens at 9am regardless of daylight saving or the viewer's device.
-- Each day is a LIST so a lunch or prayer closure can be added later as a UI
-- change alone. An empty list means closed; an absent key means the same.
--
-- Deliberately no CHECK constraint on the shape: it would be long, hard to
-- read, and would have to be rewritten when split shifts arrive -- for data
-- only this app writes, through one editor. src/lib/store-hours.ts is the real
-- guard and it is unit-tested.

alter table public.shops
  add column opening_hours jsonb not null default '{}'::jsonb;

comment on column public.shops.opening_hours is
  'Weekly opening hours keyed by weekday (mon..sun), each an array of {open,close} local wall-clock HH:MM strings. Empty array = closed that day. {} = not set. Validated in src/lib/store-hours.ts, not by a constraint.';
