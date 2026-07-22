insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

create policy "product images public read"
  on storage.objects for select
  using (bucket_id = 'product-images');

create policy "owners upload their shop's product images"
  on storage.objects for insert
  with check (
    bucket_id = 'product-images'
    and public.owns_shop((storage.foldername(name))[1]::uuid)
  );

create policy "owners delete their shop's product images"
  on storage.objects for delete
  using (
    bucket_id = 'product-images'
    and public.owns_shop((storage.foldername(name))[1]::uuid)
  );
