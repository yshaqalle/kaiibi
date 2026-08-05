-- A barcode has to identify exactly one product per shop. Otherwise a scan is
-- ambiguous by construction and the till can ring up the wrong item -- the one
-- failure mode a scanner exists to eliminate.
--
-- Enforced in the database rather than only in the form, because the form is
-- not the only writer: the CSV importer, a second till, and any future RPC all
-- reach `products` directly.

-- Normalize before constraining. These columns were never validated, so a
-- barcode may carry stray whitespace or be an empty string rather than NULL,
-- and either would defeat a uniqueness check that the human eye would call a
-- duplicate. Both statements only remove padding or turn '' into NULL, so
-- nothing a shop actually typed is lost.
--
-- The trigger disable is load-bearing, not defensive. `products_module`
-- (20260818000400) fires BEFORE INSERT OR UPDATE and raises
-- `module_not_included` for any shop whose plan does not include the
-- `inventory` module. A blanket normalizing UPDATE would therefore abort this
-- migration on the first row belonging to such a shop. This is a data repair
-- performed by the system, not a write by a shop, so the plan gate does not
-- apply to it. (`products_limit` is BEFORE INSERT and `products_uncount` is
-- AFTER DELETE, so neither is reachable from an UPDATE -- this is the only
-- trigger that needs disabling.)
alter table public.products disable trigger products_module;

update public.products
   set barcode = nullif(btrim(barcode), '')
 where barcode is distinct from nullif(btrim(barcode), '');

update public.products
   set sku = nullif(btrim(sku), '')
 where sku is distinct from nullif(btrim(sku), '');

alter table public.products enable trigger products_module;

-- Fail loudly and legibly rather than with a bare index error. Whoever runs
-- this needs to know that duplicates are the reason and that their data is
-- untouched; auto-resolving them here (nulling one side, say) would be silent
-- data loss on rows only the shop can judge.
do $$
declare v_dupes int;
begin
  select count(*) into v_dupes from (
    select shop_id, barcode
      from public.products
     where barcode is not null
     group by shop_id, barcode
    having count(*) > 1
  ) d;

  if v_dupes > 0 then
    raise exception
      'Cannot enforce barcode uniqueness: % shop/barcode pair(s) are duplicated. Resolve them before applying this migration.', v_dupes;
  end if;
end $$;

-- Unique AND the lookup index scanning needs: a unique partial index serves
-- `barcode = $1` equality just as well as a plain one, so this is one index
-- doing both jobs. Partial because most catalogs have plenty of rows with no
-- barcode, and a NULL can never satisfy an equality lookup anyway.
create unique index if not exists products_shop_barcode_key
  on public.products (shop_id, barcode)
  where barcode is not null;

-- SKU stays deliberately non-unique -- it is an internal label, and scanning
-- only falls back to it when a barcode misses. But that fallback is a lookup,
-- so it needs its own index: Postgres cannot serve an OR across two columns
-- from one composite index.
create index if not exists products_shop_sku_idx
  on public.products (shop_id, sku)
  where sku is not null;

comment on column public.products.barcode is
  'Scannable code (EAN/UPC/Code128/...). Unique per shop -- see products_shop_barcode_key.';
