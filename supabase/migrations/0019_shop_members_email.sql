-- auth.users.email isn't queryable from the client (no RLS/grant exposes
-- it), so the Staff list has nowhere to read a staff member's email from
-- once shop_members exists. Denormalize it at provision time instead --
-- provision-staff (the only place a shop_members row is ever created)
-- already knows the email it just created the auth user with.
alter table public.shop_members add column if not exists email text;
