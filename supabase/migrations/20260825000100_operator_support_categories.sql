-- The operator's category list is not the store's, and the check constraint
-- only knew the store's.
--
-- 20260825000000 mirrored SupportCategory (broken, help, billing, access, data,
-- hardware, feature, other) because at that point only a store could open a
-- thread. OPERATOR_CATEGORIES in src/lib/support-taxonomy.ts is a different and
-- shorter list -- billing, account, problem, changed, other -- and three of its
-- five keys are not in the constraint at all. An operator opening a thread
-- about someone's account would have hit a check violation on insert, i.e. the
-- feature's headline action failing on three of its five buttons.
--
-- A separate migration rather than an edit to 20260825000000 because that file
-- is already applied here AND on the remote project: an edit would be a fix
-- only a fresh database ever gets.
--
-- Split by opened_by rather than unioned into one list. The two vocabularies
-- describe different things -- an operator never files a hardware fault against
-- a customer, and a store has no use for "something's changed" -- so a union
-- would let each end write categories the other end's filter chips cannot show
-- and nothing would ever say so. The overlap (billing, other) is real overlap,
-- not a coincidence to be collapsed.
alter table public.support_threads
  drop constraint support_threads_category_check;

alter table public.support_threads
  add constraint support_threads_category_check check (
    case opened_by
      when 'shop' then category in (
        'broken', 'help', 'billing', 'access', 'data', 'hardware', 'feature', 'other'
      )
      else category in ('billing', 'account', 'problem', 'changed', 'other')
    end
  );
