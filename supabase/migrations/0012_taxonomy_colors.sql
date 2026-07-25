-- Optional color-coding for brands/categories/tags — auto-assigned from a
-- fixed palette when first created (see src/lib/colors.ts), user-editable
-- at any time from Settings. Nullable/optional throughout: older rows and
-- anything created before this migration just render with no accent color.
alter table public.brands add column if not exists color text;
alter table public.categories add column if not exists color text;
alter table public.tags add column if not exists color text;
