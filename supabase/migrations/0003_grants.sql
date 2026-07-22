grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.shops to authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, insert, update, delete on public.sales to authenticated;
grant select, insert, update, delete on public.sale_items to authenticated;

grant execute on function public.complete_sale(uuid, jsonb, text, text) to authenticated;
grant execute on function public.owns_shop(uuid) to authenticated;
