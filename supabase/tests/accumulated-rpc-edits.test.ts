// The copy-forward convention, guarded.
//
// This repo re-creates `complete_sale` and `edit_sale` IN FULL in every migration
// that touches them -- eighteen migrations and counting for complete_sale alone.
// Each copy is ~350 lines, and each one is a chance to copy from the wrong
// ancestor and silently drop an edit someone made in between.
//
// That is not hypothetical. The maturation guard ("only points that have
// finished maturing can be spent") shipped in 20260820000100 and was gone by
// 20260822000000, which copied from an older ancestor. It stayed gone through
// 20260826000100 and was only noticed in 20260831000100 -- meaning the loyalty
// maturing window was unenforced in production for four migrations. The test
// that caught it, verify-loyalty check 11, had been failing the whole time
// against a database nobody was resetting.
//
// So this asserts, on every `npm test` run, that each edit ever made to these
// two functions is still in the newest definition of them. It reads the
// migration text rather than the database, deliberately: a lost edit is a
// mistake in the SQL file, and it should fail before anyone applies it.
//
// WHEN THIS FAILS: you copied a function forward and dropped something. The
// failing entry names the migration that introduced it -- go and read that one,
// put the edit back, and do not delete the entry here.
//
// WHEN YOU ADD AN EDIT: add an entry for it, so the next copy-forward cannot
// lose yours either.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'migrations');

// The newest file that defines the function, found rather than hardcoded -- the
// point of this test is to keep working as migrations land, including ones
// written by someone who has never read it.
function newestDefinitionOf(fn: string): { file: string; body: string } {
  const signature = `create or replace function public.${fn}(`;
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const matches = files.filter((name) => readFileSync(join(MIGRATIONS, name), 'utf8').includes(signature));
  if (matches.length === 0) throw new Error(`no migration defines ${fn}`);
  const file = matches[matches.length - 1];
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const start = text.indexOf(signature);
  // To the end of the function, not the end of the file: a migration that
  // defines several would otherwise let one function's edit satisfy another's.
  const end = text.indexOf('$$;', start);
  return { file, body: text.slice(start, end) };
}

type Edit = [introducedIn: string, what: string, token: string];

const COMPLETE_SALE_EDITS: Edit[] = [
  ['0005', 'split payments across methods', 'insert into public.sale_payments'],
  ['0007', 'customer name/phone/email on the sale', 'p_customer_email'],
  ['0009', 'which cashier rang it up', 'p_cashier_name'],
  ['0013', 'order-level discount', 'p_discount_cents'],
  ['0015', 'sales tax', 'v_tax_cents'],
  ['0015', 'foreign-currency tender and change', 'foreign_change_cents'],
  ['0023', 'link to a customer record', 'p_customer_id'],
  ['0024', 'pos.access permission gate', "has_shop_permission(p_shop_id, 'pos.access')"],
  ['0024', 'manual discounts need discounts.manual', "'discounts.manual'"],
  ['20260801232553', 'backdated sales for CSV import', 'p_created_at'],
  ['20260804000000', 'frozen unit cost for COGS', 'unit_cost_cents'],
  ['20260809000000', 'sales belong to a location', 'p_location_id'],
  ['20260810000100', 'stock comes off the location, not the product', 'product_location_stock'],
  ['20260820000000', 'loyalty points earned', "'earn'"],
  ['20260820000000', 'loyalty points redeemed', "'redeem'"],
  ['20260820000000', 'a lapsed shop can still sell', "shop_has_module(p_shop_id, 'customers')"],
  // The one that was actually lost. Left deliberately specific: it is the
  // computation, not merely a mention of maturing.
  ['20260820000100', 'only matured points may be redeemed', 'v_pending_points'],
  ['20260822000000', 'sales filed against a register session', 'p_register_session_id'],
  ['20260822000000', 'a closed session is refused', 'is already closed'],
  ['20260822000000', 'a store may require an open register', 'require_open_register'],
  ['20260826000100', 'which promotion took the money off', 'promotion_name'],
  ['20260826000100', 'the promotion window is re-checked server-side', 'v_expected_discount'],
  ['20260831000100', 'a sale may be left part-paid on purpose', 'p_allow_balance'],
  ['20260831000100', 'a sale nobody paid reads as unpaid', "'unpaid'"],
  // Introduced in 20260905000000, but it could not be guarded here until now:
  // that migration rewrites complete_sale by TEXT SUBSTITUTION against the live
  // pg_proc source rather than re-creating it, so until 20260908000200 the
  // newest `create or replace` text -- the only thing this test can read -- did
  // not contain the fix, and this entry would have failed against a database
  // that HAD it. That is the blind spot: a text-substitution migration is
  // invisible to this guard, and 20260908000200 duly reverted the fix on its
  // first run. Now that the ORDER BY is written into the newest definition, it
  // is guarded like every other edit.
  ['20260905000000', 'locks are taken in product order, not cart order', 'with ordinality'],
  // The call itself, not the string 'sale' in a trailing argument position:
  // "'sale')" was satisfiable by any stray comment or unrelated literal that
  // happened to end that way, which is not a guard.
  ['20260908000200', 'the sale posts a journal entry', 'post_journal_entry('],
  // The PROPERTY, not the variable name. `v_cogs_cents` survives a rewrite that
  // sums products.cost_cents into it, which is the exact mistake the frozen
  // cost exists to prevent -- 20260804000000 froze the cost on the line so a
  // restock tomorrow cannot rewrite a closed month's gross profit.
  ['20260908000200', 'COGS comes from the frozen line cost', 'si.unit_cost_cents'],
  // Line and promotion discounts reach 4200. The item loop folds each line's
  // discount into v_line before adding it to v_gross_cents, so v_gross_cents is
  // already NET of them -- crediting 4000 with a bare v_gross_cents left 4200
  // reading zero for a shop whose discounts are all promotions, with revenue
  // understated by the same amount.
  ['20260908000200', 'every discount reaches 4200', 'v_item_discount_cents'],
  // Specific to the variable, not merely to account 1100. The plan for this
  // migration said to post the receivable from `v_balance` -- which in this
  // function is the customer's loyalty POINTS balance, assigned only inside the
  // redemption branch. That would have posted a receivable denominated in
  // points on a redeeming sale and none at all on a plain credit sale. Pinned
  // here so a future copy-forward cannot quietly reintroduce the wrong one.
  ['20260908000200', 'the receivable is money owed, not the points balance', 'v_owed_cents'],
  // The TIMEZONE, not merely a variable called v_entry_date. A bare
  // `coalesce(p_created_at, now())::date` resolves in the session's timezone --
  // UTC on Supabase -- so a sale at 01:30 local on the 1st was dated into the
  // previous month while src/lib/period.ts put it in this one on the sales
  // report. The disagreement is permanent once that period closes.
  ['20260908000300', 'the entry date is the shop-local date, not the server timezone', "at time zone 'Africa/Mogadishu'"],
  // A sale dated into a closed period posts to the current one rather than
  // failing. src/lib/sales-import.ts:126 backdates every imported historical
  // sale, so without this a shop that has closed any month fails the whole row
  // group with a ledger error on an import screen.
  ['20260908000300', 'a sale whose period has closed is redated, not refused', 'v_period_status'],
];

const EDIT_SALE_EDITS: Edit[] = [
  ['0015', 'sales tax is recomputed on an edit', 'v_tax_cents'],
  ['20260810000100', 'stock moves against the location', 'product_location_stock'],
  ['20260820000000', 'points are re-earned at the frozen rate', 'v_points_earned_new'],
  ['20260820000100', 'a clawback never drives the balance negative', 'greatest(coalesce(v_balance, 0), 0)'],
  ['20260826000100', 'an edit keeps which promotion applied', 'v_existing_promo_ids'],
  ['20260831000100', 'an edit may leave a balance', 'p_allow_balance'],
  // The subtlest one here: edit_sale deletes a sale's payments and re-inserts
  // what the client sent. Lossless while every payment arrived at the till at
  // once, destructive the moment money can arrive days later.
  ['20260831000100', 'an edit does not erase a settlement', 'and not is_settlement'],
  // Guardable for the first time, and for exactly the reason the complete_sale
  // entry above gives: 20260905000000 patched edit_sale by TEXT SUBSTITUTION
  // against the live pg_proc source, so until 20260908000650 the ORDER BY lived
  // in no `create or replace` text and this entry would have FAILED against a
  // database that HAD the fix. complete_sale's half of that same fix was duly
  // reverted by a copy-forward and only verify-sale-lock-order caught it;
  // edit_sale's half was unguarded here until now.
  ['20260905000000', 'locks are taken in product order, not cart order', 'with ordinality'],
  // A correction is a reversal plus a fresh entry, never an edit: a posted
  // entry is immutable, and without this an edit left revenue, COGS, tax and
  // the receivable all reading the pre-edit figures.
  ['20260908000650', 'an edit reverses the old entry rather than editing it', 'reverses_entry_id'],
  ['20260908000650', 'an edit re-posts from the edited figures', 'post_journal_entry('],
  // The PROPERTY, not a variable name. The entry date must be the shop's local
  // date; a bare now()::date resolves in UTC and every market kaiibi serves is
  // UTC+3, so a late-night correction lands in the wrong month permanently.
  ['20260908000650', 'the replacement is dated in shop-local time', 'shop_local_date'],
  // A correction to a month that has since CLOSED is recognised in the open
  // period rather than refused by open_period_for. Without it a manager
  // correcting last quarter's mis-rung sale is stopped by a ledger error on a
  // POS screen.
  ['20260908000650', 'a correction whose period has closed is redated, not refused', 'v_old_period_status'],
  // The replacement debits the TILL's payments only. A settlement already
  // carries its own Dr Cash / Cr Receivable entry, which reversing the sale's
  // entry does not touch, so re-debiting it here books the same money twice.
  ['20260908000650', 'the replacement does not re-debit a settlement', 'not sp.is_settlement'],
  // Specific to the variable, not merely to account 1100 -- the same trap
  // complete_sale's entry above pins. v_balance in this function is a loyalty
  // POINTS balance, assigned only inside the clamping branches.
  ['20260908000650', 'the receivable is money owed, not the points balance', 'v_owed_cents'],
  // Line and promotion discounts reach 4200 and revenue is credited at LIST.
  // The item loop folds each line's discount into v_line before adding it to
  // v_gross_cents, so v_gross_cents is already NET of them.
  ['20260908000650', 'every discount reaches 4200', 'v_item_discount_cents'],
];

// receive_stock joins this file at three definitions, and it belongs here more
// urgently than its line count suggests.
//
// 20260907000000 replaced "latest wins" -- where a delivery OVERWROTE a
// product's cost with its own price -- with a moving weighted average, because
// replacement cost is not one of the two formulas IAS 2.25 permits. Copying the
// function forward from 20260902000000 instead restores an impermissible cost
// basis, and it does so with NO test in verify-posting-inventory.sql going red,
// because none of those checks reads products.cost_cents. Only
// verify-weighted-average.sql catches it, and that needs a running database.
//
// This entry catches it in `npm test`, from the SQL text, before anyone applies
// the migration -- which is the whole reason this file exists.
const RECEIVE_STOCK_EDITS: Edit[] = [
  // The token is the divisor of the average rather than a variable name: any
  // implementation that still divides by (prior + received) is averaging, and
  // "latest wins" has no divisor at all.
  ['20260907000000', 'stock is valued at a moving weighted average, not the latest price paid', '/ (v_prior_qty + v_qty)'],
  // Averaged against the quantity read BEFORE the upsert. Against the
  // post-upsert figure the delivery is counted twice and the answer lands
  // between the two costs -- wrong in a way nobody would spot.
  // `v_prior_qty::numeric`, not a bare `v_prior_qty`: the bare name also appears
  // in the SELECT that reads it, so it survived a faithful wrong-ancestor copy
  // in testing while the two entries either side of it went red. The cast
  // appears only inside the average itself.
  ['20260907000000', 'the average is taken against shop-wide stock read before the upsert', 'v_prior_qty::numeric'],
  // Null is not zero. Null means nobody priced this product, and averaging it
  // as free would halve the cost of everything a shop had not got round to.
  ['20260907000000', 'a null prior cost is replaced, not averaged as zero', 'v_product.cost_cents is null'],
  ['20260908000400', 'a delivery posts to the ledger', 'post_journal_entry('],
  // Payable, not cash. This RPC records goods ARRIVING and says nothing about
  // whether they were paid for; crediting cash asserts a payment nobody made.
  ['20260908000400', 'a delivery credits 2000 Accounts Payable', "'code', '2000'"],
  // The PROPERTY, not a variable name -- the same discipline the edit_sale
  // entry above applies. now()::date resolves in UTC and Somalia is UTC+3.
  ['20260908000400', 'the entry is dated in shop-local time', 'shop_local_date'],
];

const SAVE_STOCK_COUNT_EDITS: Edit[] = [
  ['20260908000600', 'a count variance posts to the ledger', 'post_journal_entry('],
  // 5100 sits in COST OF SALES, above gross profit -- not in the 6000s, where
  // the Count door's stock_loss expense category lands. A unit that is stolen
  // or breaks is never sold, so its cost never enters COGS by any other path.
  ['20260908000600', 'shrinkage is a cost of sales, not an operating expense', "'code', '5100'"],
  // Two branches, not one signed one. The amounts are identical either way --
  // the sign convention flips the direction for free -- so what the second
  // branch buys is an entry that SAYS what happened.
  ['20260908000600', 'an over-count reverses the entry rather than posting a negative shrinkage', 'Stock found'],
  ['20260908000600', 'the entry is dated in shop-local time', 'shop_local_date'],
];

describe.each([
  ['complete_sale', COMPLETE_SALE_EDITS],
  ['edit_sale', EDIT_SALE_EDITS],
  ['receive_stock', RECEIVE_STOCK_EDITS],
  ['save_stock_count', SAVE_STOCK_COUNT_EDITS],
] as const)('%s keeps every edit ever made to it', (fn, edits) => {
  const { file, body } = newestDefinitionOf(fn);

  it.each(edits)(`%s: %s`, (introducedIn, what, token) => {
    if (!body.includes(token)) {
      throw new Error(
        `${fn} in ${file} has lost "${what}", introduced in ${introducedIn}.\n` +
          `Expected to find: ${token}\n` +
          `You copied the function forward from an ancestor older than ${introducedIn}. ` +
          `Read that migration, put the edit back, and do not delete this entry.`
      );
    }
  });

  it('is the only definition in its own migration that this test read', () => {
    // Guards the slicing above rather than the SQL: if `$$;` ever stops ending
    // the function, every assertion here would start passing for the wrong
    // reason -- matching tokens from whatever followed it in the file.
    expect(body).toContain(`create or replace function public.${fn}(`);
    expect(body.split(`create or replace function public.`)).toHaveLength(2);
  });
});
