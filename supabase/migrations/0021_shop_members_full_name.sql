-- Same issue as 0019's `email` column: `shop_members` and `profiles` both
-- reference `auth.users` but have no direct foreign key to each other, so
-- PostgREST can't embed `profiles(full_name)` in a shop_members query --
-- it errored outright ("Could not load account data"). Denormalize
-- full_name at provision time too, same as email.
alter table public.shop_members add column if not exists full_name text;
