-- Makes "is this bill settled?" a queryable fact rather than something the
-- client works out after fetching everything.
--
-- The bills screen needs two different sets: every *unpaid* bill (for the
-- outstanding/overdue totals, which must be complete or they understate the
-- debt) and bills issued in the selected range (for the list). It was getting
-- both from one unbounded `select *` over every bill the shop had ever
-- recorded, with nested payments -- fine at ten bills, not at ten thousand.
--
-- Settled-ness is derived from two columns already on the row, so a generated
-- column keeps it exact and impossible to get out of step, unlike a flag
-- something has to remember to maintain. PostgREST can't compare two columns
-- in a filter, so without this the "unpaid only" query isn't expressible at
-- all and the work lands on the client by default.
alter table public.invoices
  add column if not exists settled boolean
  generated always as (paid_cents >= amount_cents) stored;

comment on column public.invoices.settled is
  'Derived: the bill is fully paid. Generated, so it can never disagree with paid_cents/amount_cents.';

-- Partial index: the outstanding-totals query only ever looks at unpaid bills,
-- and those stay a small slice of the table as history accumulates. Indexing
-- just them keeps that query flat over time rather than growing with every
-- bill ever settled.
create index if not exists invoices_unsettled_idx
  on public.invoices (shop_id)
  where not settled;

-- The list is filtered by issue date; the existing index is on due_on, which
-- doesn't serve that.
create index if not exists invoices_shop_issued_idx
  on public.invoices (shop_id, issued_on desc);
