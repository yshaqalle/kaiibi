-- Per-shop payment method availability + whether a sale can combine more
-- than one payment method — Settings → Payments (src/components/payment-method-picker.tsx
-- reads these to filter/gate the POS checkout). Defaults match the
-- unconditional behavior every shop already had before this setting
-- existed (all three methods + split always allowed), so applying this
-- migration changes nothing until an owner explicitly turns something off.
alter table public.shops add column if not exists payment_cash_enabled boolean not null default true;
alter table public.shops add column if not exists payment_zaad_enabled boolean not null default true;
alter table public.shops add column if not exists payment_edahab_enabled boolean not null default true;
alter table public.shops add column if not exists payment_split_enabled boolean not null default true;
