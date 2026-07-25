-- A shop-level return policy, editable in Settings and printed on every
-- receipt (Print/Save/Email/WhatsApp) — see src/lib/receipt.ts.
alter table public.shops add column if not exists return_policy text;
