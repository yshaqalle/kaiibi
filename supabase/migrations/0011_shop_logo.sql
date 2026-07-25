-- A shop logo, shown in the owner sidebar avatar and printed/embedded on
-- receipts (Print/Save/Email/WhatsApp) — see src/lib/receipt.ts. Stored in
-- the existing `product-images` bucket (migration 0002); its RLS only
-- keys off the first path segment being the shop id, not the kind of
-- image, so no new bucket/policies are needed.
alter table public.shops add column if not exists logo_url text;
