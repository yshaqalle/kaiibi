-- Receipt customization, editable in Settings — whether the logo/cashier
-- name print on a receipt, and whether checkout auto-prints or auto-shares
-- via WhatsApp. See src/lib/receipt.ts (show-logo/show-cashier-name) and
-- src/components/receipt-modal.tsx (auto-print/auto-whatsapp), both driven
-- from these columns.
alter table public.shops add column if not exists receipt_show_logo boolean not null default true;
alter table public.shops add column if not exists receipt_show_cashier_name boolean not null default true;
alter table public.shops add column if not exists receipt_auto_print boolean not null default false;
alter table public.shops add column if not exists receipt_auto_whatsapp boolean not null default false;
