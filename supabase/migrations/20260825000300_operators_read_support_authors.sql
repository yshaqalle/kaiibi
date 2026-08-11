-- The operator answering a support thread needs to know who wrote it.
--
-- A NEW file rather than an edit to 20260825000000: that migration is already
-- applied to the remote project, so editing it would leave the deployed
-- database and this repository describing different schemas.
--
-- Until now `profiles` carried exactly one policy -- "own profile", from
-- 0001_init -- so the console's author column was always blank and its phone
-- number always missing. The thread already tells an operator which SHOP wrote
-- in; without this it cannot tell them which PERSON, which is the difference
-- between "Hooyo Market says the scanner is dead" and being able to call back
-- the cashier who is standing in front of it.
--
-- Narrow on purpose. It reads support_threads.author_user_id and nothing else,
-- so writing to support is what puts a profile in reach and the profiles of
-- everyone who never has stay invisible. verify-platform-portal.sql asserts the
-- blast radius of a stolen operator account -- products, sales, customers,
-- expenses, shifts and the staff roster all still return zero rows -- and this
-- policy is deliberately not a step toward widening any of them.
--
-- `for select` only: profiles already grants authenticated insert/update/delete
-- table-wide (0003_grants, narrowed to (full_name, phone) by 0017), and an
-- `for all` policy here would let an operator rename a customer. Reading who
-- wrote to us is the entire need.
-- The column the policy's subquery keys on, and until now nothing indexed it:
-- support_threads carries indexes on (shop_id, last_message_at) and
-- (status, last_message_at) only. Without this the exists below is a sequential
-- scan of every thread, once per profile row being tested.
create index if not exists support_threads_author_idx
  on public.support_threads (author_user_id);

create policy "operators read the profile of a support author"
  on public.profiles for select
  to authenticated
  using (
    -- Cheapest test first: for every non-operator this short-circuits before
    -- the subquery, and this policy is evaluated on every profiles read in the
    -- app, not just the console's.
    public.is_platform_admin()
    and exists (
      select 1 from public.support_threads t where t.author_user_id = profiles.id
    )
  );
