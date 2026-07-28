-- Photo + description for brands/categories — same treatment as `color` in
-- migration 0012: nullable/optional throughout, so anything created before
-- this migration just renders with no photo/description.
alter table public.brands add column if not exists description text;
alter table public.brands add column if not exists image_url text;
alter table public.categories add column if not exists description text;
alter table public.categories add column if not exists image_url text;
