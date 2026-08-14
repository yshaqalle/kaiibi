-- A promotion a campaign is telling people about cannot be deleted out from
-- under it.
--
-- 20260826000100 introduced delete_or_archive_promotion with the right rule --
-- destroy an offer nobody used, archive one that has history -- but it only
-- ever looked at sale_items. That was the whole story when it was written,
-- because a promotion's only trace was the sales it had discounted.
--
-- Campaigns changed that. A campaign holds `promotion_id` and builds the very
-- words a customer reads from it, and `on delete set null` means deleting the
-- offer leaves the campaign pointing at nothing. The message then goes out as
-- "Hi Amina -- something special at Suuqa Xamar until ." -- a garbled sentence
-- advertising an offer that no longer exists, sent to a real phone.
--
-- The exposure is worst exactly where the old check is weakest. `v_used` is
-- false precisely when NO sale has redeemed the offer yet, which is the state
-- a promotion is in WHILE its campaign is still being sent. An owner who
-- creates "Eid -- 20% off", messages thirty of eighty-four people, changes
-- their mind and deletes the offer hits the one path where nothing stops
-- them, and the remaining fifty-four get the garbled version.
--
-- Archiving instead is already handled everywhere downstream: archived_at is
-- what promotionLiveIssue reads to stop a queue sending, getPromotion still
-- resolves the row so an old campaign can name what it advertised, and the
-- promotions list already hides archived offers. Only this predicate was
-- missing.
--
-- Reproduced verbatim from 20260826000100 with the single extra `or exists`;
-- see that migration's own note on CREATE OR REPLACE FUNCTION replacing a
-- whole body.
create or replace function public.delete_or_archive_promotion(p_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_shop_id uuid;
  v_used boolean;
begin
  select shop_id into v_shop_id from public.promotions where id = p_id;
  if v_shop_id is null then
    raise exception 'promotion % not found', p_id;
  end if;
  -- The same gate the table's own write policy uses (0024). Security definer
  -- bypasses RLS, so this function must re-assert what RLS would have.
  if not public.has_shop_permission(v_shop_id, 'settings.access') then
    raise exception 'not authorized for shop %', v_shop_id;
  end if;

  -- "Has anything come to depend on this offer" -- a sale that applied it, or
  -- a campaign that is telling customers about it. Either makes deleting the
  -- row destructive rather than tidy.
  select exists (select 1 from public.sale_items where promotion_id = p_id)
      or exists (select 1 from public.campaigns where promotion_id = p_id)
    into v_used;

  if v_used then
    update public.promotions set archived_at = now() where id = p_id;
    return 'archived';
  end if;

  delete from public.promotions where id = p_id;
  return 'deleted';
end;
$$;
