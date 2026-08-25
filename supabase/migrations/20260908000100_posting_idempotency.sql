-- What has already been posted, so nothing posts twice.
--
-- The alternative -- deriving "posted" from the existence of a journal entry
-- whose description mentions the sale -- is a string match standing in for a
-- foreign key, and it fails the first time two sales in one second get the same
-- description.
--
-- NO ON DELETE CASCADE, deliberately: deleting a journal entry must not be a
-- way to silently un-post a sale. The reference is what stops the entry being
-- deleted at all, which is the behaviour wanted.

alter table public.sales            add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.refunds          add column if not exists journal_entry_id uuid references public.journal_entries(id);
-- On sale_payments rather than sale_balances: a settlement is a payment row
-- (is_settlement = true), and a sale can be settled in several instalments,
-- each of which is its own entry on its own date.
alter table public.sale_payments    add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.stock_receipts   add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.expenses         add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.invoice_payments add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.payroll_runs     add column if not exists journal_entry_id uuid references public.journal_entries(id);
alter table public.stock_counts     add column if not exists journal_entry_id uuid references public.journal_entries(id);

-- Partial, because the only question ever asked is "what is NOT yet posted".
-- Once the backfill has run these indexes are nearly empty, which is the point.
create index if not exists sales_unposted_idx            on public.sales(shop_id)          where journal_entry_id is null;
-- Keyed on sale_id, not shop_id: refunds has no shop_id column of its own --
-- a shop is only reachable via refunds.sale_id -> sales.shop_id. sale_id is
-- also the join key the backfill will use to get there, so it's the right
-- column even though every sibling index here is keyed on shop_id directly.
create index if not exists refunds_unposted_idx          on public.refunds(sale_id)        where journal_entry_id is null;
create index if not exists stock_receipts_unposted_idx   on public.stock_receipts(shop_id) where journal_entry_id is null;
create index if not exists expenses_unposted_idx         on public.expenses(shop_id)       where journal_entry_id is null;
create index if not exists payroll_runs_unposted_idx     on public.payroll_runs(shop_id)   where journal_entry_id is null;
create index if not exists stock_counts_unposted_idx     on public.stock_counts(shop_id)   where journal_entry_id is null;
