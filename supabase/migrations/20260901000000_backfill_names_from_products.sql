-- Gives every category, brand and tag that only ever existed as free text on a
-- product a row of its own.
--
-- ## What was broken
--
-- `products.category`, `products.brand` and `products.tags` are free text, and
-- the `categories`/`brands`/`tags` tables are the shop's LIST of them -- not a
-- cache of what happens to be on the products. Two places wrote both: Settings'
-- Add button, and the product form when someone typed a name that wasn't in the
-- table yet. CSV import wrote only the product.
--
-- So a shop that built its catalogue by import had categories on every product
-- and almost no rows in `categories`. POS builds its filter row from
-- `listCategories()`, so those categories had no chip -- reported as "no more
-- than 10 categories shows up", because the ten that showed were the ten
-- someone had typed by hand. Nothing was ever capped.
--
-- src/lib/products-import.ts now registers the names it imports, which closes
-- the hole going forward. This is the other half: the shops already carrying it.
--
-- ## Why this is safe to run for everyone
--
-- Every inserted name is one the shop's own products already carry, so no shop
-- gains a category it never used. It only ever INSERTS -- `on conflict do
-- nothing` means an existing row keeps its colour, description and image -- and
-- it cannot delete or rename anything. Re-running it changes nothing.
--
-- ## The case-insensitive part
--
-- `unique (shop_id, name)` is case-sensitive, so products carrying "Serum" and
-- "serum" would otherwise become two rows and two chips for one category. Each
-- distinct-by-lower-case name is inserted once, and the spelling kept is the
-- one on the earliest-created product -- the shop's first use of it, which is
-- the closest thing to an intended spelling that the data holds.
--
-- Names already in the table are excluded case-insensitively too: a shop with
-- "Serum" typed by hand and "serum" on its imported products keeps the one row
-- it has rather than gaining a near-duplicate.

-- Categories --------------------------------------------------------------
insert into public.categories (shop_id, name)
select distinct on (p.shop_id, lower(btrim(p.category)))
       p.shop_id,
       btrim(p.category)
  from public.products p
 where p.category is not null
   and btrim(p.category) <> ''
   and not exists (
         select 1 from public.categories c
          where c.shop_id = p.shop_id
            and lower(c.name) = lower(btrim(p.category))
       )
 order by p.shop_id, lower(btrim(p.category)), p.created_at
on conflict (shop_id, name) do nothing;

-- Brands ------------------------------------------------------------------
insert into public.brands (shop_id, name)
select distinct on (p.shop_id, lower(btrim(p.brand)))
       p.shop_id,
       btrim(p.brand)
  from public.products p
 where p.brand is not null
   and btrim(p.brand) <> ''
   and not exists (
         select 1 from public.brands b
          where b.shop_id = p.shop_id
            and lower(b.name) = lower(btrim(p.brand))
       )
 order by p.shop_id, lower(btrim(p.brand)), p.created_at
on conflict (shop_id, name) do nothing;

-- Tags --------------------------------------------------------------------
-- `products.tags` is an array, so each product contributes several names and
-- the unnest has to happen before the distinct.
insert into public.tags (shop_id, name)
select distinct on (t.shop_id, lower(t.name))
       t.shop_id,
       t.name
  from (
         select p.shop_id, btrim(tag) as name, p.created_at
           from public.products p
           cross join lateral unnest(coalesce(p.tags, array[]::text[])) as tag
       ) t
 where t.name <> ''
   and not exists (
         select 1 from public.tags existing
          where existing.shop_id = t.shop_id
            and lower(existing.name) = lower(t.name)
       )
 order by t.shop_id, lower(t.name), t.created_at
on conflict (shop_id, name) do nothing;
