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
  // A sale that moves no money posts NOTHING rather than raising. Every line is
  // conditional, so a basket of free samples left on account (legal since
  // p_allow_balance) builds an empty array and post_journal_entry answered
  // `A journal entry needs at least two lines; this one has 0.` -- a new
  // failure, at the till, for an operation that worked before this branch.
  ['20260908000900', 'a sale that moves no money posts nothing', 'jsonb_array_length(v_lines)'],
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
  // The reversal files under 'sale', not the 'manual' this block first
  // inherited from reverse_journal_entry. A reversal carries the SAME SOURCE as
  // the entry it reverses, or `where source = 'sale'` returns an edited sale's
  // original and its replacement but not the reversal cancelling the original
  // -- and a report grouping by source shows that sale's revenue twice.
  ['20260908000900', "the reversal is filed under 'sale', not 'manual'", "'sale', 'posted', v_old_location_id"],
  // Same as complete_sale's: an edit that leaves the sale worth nothing posts
  // nothing rather than failing on a ledger error at a POS screen.
  ['20260908000900', 'an edit that leaves the sale worth nothing posts nothing', 'jsonb_array_length(v_lines)'],
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
  // Costing a product that ALREADY HELD STOCK is a revaluation: the delivery
  // prices the whole holding (there is nothing to average against), so the
  // units on the shelf acquire a value the ledger has never carried a cent of
  // and that nothing else will ever put there. Without this entry, 50 uncosted
  // units + a delivery of 10 @ 100 + selling all 60 leaves 1200 at -5,000.
  //
  // The token is the ARITHMETIC -- the shop-wide prior quantity at the new
  // cost -- not a variable name and not `v_reval_cents`, which a copy-forward
  // could keep as a declaration while dropping the accumulation that fills it.
  ['20260908001800', 'stock costed after it was already on the shelf is revalued', 'v_prior_qty::bigint * v_new_cost'],
  // And the counterpart, which is the half a build gets wrong. These goods are
  // not owed to a supplier (2000), not a loss (5100) and not income (4xxx) --
  // they are the owner's own stock, measurable for the first time, exactly as
  // the opening balance in 20260908001300 treats it.
  ['20260908001800', "the revaluation credits 3000 Owner's Capital", "'code', '3000'"],
];

// The five that follow, plus delete_sale, joined this file at the phase 2b
// final review. Until then it guarded four functions while EIGHT carried
// posting code -- and the guard is not about the posting code alone. A
// function that is re-created in full by every migration touching it needs an
// entry for every edit that matters, or a copy from the wrong ancestor takes
// it out silently.
//
// refund_sale_items is the strongest omission of the five and the reason the
// list was written in this order. It has NINE full reproductions and it carries
// two edits that pay customers the wrong amount if either is lost:
// 20260820000200 (a refund is scaled to what the customer actually paid, not to
// the line totals -- 163 cents too much on the report's own $19.99 example) and
// 20260831000200 (the goods/cash split, without which refunding a credit sale
// nobody has paid a cent on takes the full amount out of the drawer). Neither
// is visible in a totals check that recomputes the same way the function does.

const REFUND_SALE_ITEMS_EDITS: Edit[] = [
  // The clamp, not merely a mention of the balance: a refund the shop agreed to
  // give must never post the customer a NEGATIVE points balance.
  ['20260820000100', 'a clawback never drives the balance negative', 'greatest(coalesce(v_balance, 0), 0)'],
  // Redeemed points come back all-or-nothing on a FULL return, exactly once.
  ['20260820000100', 'a redemption is reversed once, and only on a full return', "'redeem_reversed'"],
  // THE MONEY ONE. The per-line loop apportions line_total_cents, which knows
  // nothing about the order discount, the points redeemed or the tax. The
  // amounts are scaled to sales.total_cents CUMULATIVELY and then differenced,
  // so refunding a sale in pieces returns exactly what refunding it at once
  // would. The token is the COMPUTATION, not the variable name: a rewrite that
  // neuters the scaling and leaves `v_cum_goods_cents integer;` standing in the
  // declarations would satisfy a name and lose the money.
  ['20260820000200', 'a refund is scaled to what the customer actually paid, cumulatively',
    'round(v_sale_total_cents::numeric * v_cum_gross_all / v_sale_gross_cents)'],
  // THE OTHER MONEY ONE. goods_cents is what came back; total_cents is the CASH
  // handed over, capped at what was actually collected and not already
  // refunded. Lose the cap and refunding a credit sale nobody has paid takes
  // the full amount out of the till. The token is the cap, not the column.
  ['20260831000200', 'cash handed back is capped at what was collected', 'least(v_goods_cents, greatest(v_collected_cents'],
  ['20260908000350', 'a refund posts to the ledger', 'post_journal_entry('],
  // 4100 Sales Returns, never a negative 4000: a refund that reduced Sales
  // Revenue would make a month's revenue depend on when the return happened
  // rather than on when the sale did.
  ['20260908000350', 'a return debits 4100 Sales Returns, never 4000', "'code', '4100'"],
  // The PROPERTY, not a variable name. A bare now()::date resolves in UTC and
  // every market kaiibi serves is UTC+3. The trailing comma pins it to the
  // entry-date ARGUMENT: the function also carries a comment explaining the
  // rule, and a token that matched the explanation would survive the defect.
  ['20260908000350', 'the entry is dated in shop-local time', 'public.shop_local_date(),'],
  // A refund on a split-tender sale credits every tender it came in on, in
  // proportion. One lumped line against the biggest method disagrees with
  // register_session_expected, which pro-rates the same refund the same way --
  // so the drawer count and the ledger drift apart with nothing to explain it.
  ['20260908000360', 'a refund credits every tender it came in on', 'public.account_code_for_payment_method(method)'],
  // LARGEST REMAINDER, not "give the difference to the biggest method": every
  // line then lands within a cent of its exact share and none can come out
  // NEGATIVE -- a negative credit is a refund that puts money INTO a tender.
  ['20260908000360', 'the pro-rata split uses largest remainder', 'row_number() over (order by exact - floor(exact) desc'],
];

const SETTLE_SALE_BALANCE_EDITS: Edit[] = [
  ['20260908000350', 'settling a balance posts to the ledger', 'post_journal_entry('],
  // Dr the tender / Cr 1100, and NO revenue. The revenue was recognised when
  // the sale was rung up and the receivable is what recorded it; recognising it
  // again when the money arrives is the classic double-count. 1100 is what says
  // this entry clears a debt rather than earning anything.
  ['20260908000350', 'a settlement clears the receivable rather than posting revenue', "'code', '1100'"],
  ['20260908000350', 'the money lands in the wallet the method maps to', 'public.account_code_for_payment_method(v_method)'],
  ['20260908000350', 'the entry is dated in shop-local time', 'public.shop_local_date(),'],
  // The SETTLING till's store, not the sale's. Money handed over days later at
  // whatever till is open -- possibly another branch. 20260831000300 makes
  // exactly this fix on the drawer side; a ledger stamped with the sale's
  // branch puts the same cash in two branches that can never be reconciled.
  ['20260908000360', "the entry carries the settling till's store, not the sale's", 'coalesce(v_session.location_id, v_sale.location_id)'],
  // THE MONEY ONE for this function. v_owed subtracts the VALUE of the goods
  // returned and adds the CASH handed back on again -- the cash leaving the
  // drawer is a payment running backwards. Without the second half this RPC
  // refused to collect more than the understated figure and then stamped
  // settled_at, stranding the difference in 1100 Accounts Receivable where no
  // screen in the app could reach it. The token is the whole expression, not
  // `v_cash_refunded`: a rewrite that declares the variable, reads it and never
  // adds it satisfies the name and loses the money. customer_balances computes
  // the identical arithmetic and the two must never diverge.
  ['20260908001400', 'the cash a refund handed back is still owed',
    'v_sale.total_cents - v_refunded - v_paid + v_cash_refunded'],
];

const RECORD_INVOICE_PAYMENT_EDITS: Edit[] = [
  ['20260908000500', 'paying a supplier posts to the ledger', 'post_journal_entry('],
  // Dr 2000 Accounts Payable and NO expense line. The cost was recognised when
  // the bill arrived; posting 6xxx again here would double every cost the shop
  // has, and the wrong entry balances perfectly.
  ['20260908000500', 'a payment settles 2000 Accounts Payable and posts no expense', "'code', '2000'"],
  ['20260908000500', 'the credit lands on the wallet the method maps to', 'account_code_for_payment_method(p_method)'],
  // The DEFAULT, not the parameter. p_paid_on is a date and is exempt from the
  // shop_local_date() rule; its default was not, and src/lib/invoices.ts omits
  // p_paid_on whenever the user does not pick a date -- so `default
  // current_date` decided the date in UTC for the common case.
  ['20260908000500', "p_paid_on defaults to the shop's local date", 'p_paid_on date default public.shop_local_date()'],
  // The one posting site with a user-chosen date. record-payment-modal.tsx has
  // a free date field and post_journal_entry raises on a closed month, so
  // without the redirect a back-dated supplier payment fails on the Bills
  // screen for an operation that worked before phase 2b.
  ['20260908000500', 'a payment back-dated into a closed month is redated, not refused', 'select status into v_period_status'],
];

const POST_PAYROLL_RUN_EDITS: Edit[] = [
  ['20260804020100', 'a line with a blocking warning and no amount stops the run', 'warning_blocking'],
  // Per-member, not shop-wide. Overlapping drafts are the normal mode once pay
  // cadence is per member, and without this the same member is paid twice.
  ['20260804030100', 'an overlapping run cannot pay the same member twice', 'r.period_start <= v_run.period_end'],
  // The row lock covers THIS run only, so two overlapping runs sharing a member
  // each locked a different row and neither saw the other's uncommitted status.
  ['20260804040000', 'posting is serialised per shop by an advisory lock', 'pg_advisory_xact_lock'],
  // The run's store travels onto the cost it produces, or a pay run for one
  // store posts a business-wide expense and that store's P&L shows its revenue
  // with none of its labour against it.
  ['20260816000000', "the run's store travels onto the expense it produces", 'v_run.location_id'],
  ['20260908000500', 'a pay run posts to the ledger', 'post_journal_entry('],
  // Cash, not 2200 Wages Payable: a posted run HAS been paid. 6200/2200
  // balances just as happily while saying the opposite about the staff.
  ['20260908000500', 'a posted run credits 1000 Cash, not 2200 Wages Payable', "'code', '1000'"],
  // The PROPERTY. payroll_runs has no paid_on, so the entry is dated the shop's
  // local date; current_date resolves in UTC and Somalia is UTC+3, so a
  // late-evening run lands on the wrong day and, at a month boundary,
  // permanently in the wrong period.
  ['20260908000500', 'the entry is dated in shop-local time', 'shop_local_date'],
  // A draft still holding an entry id is a state nothing can produce. Refused
  // loudly rather than overwritten: overwriting orphans the old entry and
  // doubles 6200 with a trial balance that still zeroes.
  ['20260908000500', 'a run already carrying an entry is refused, not overwritten', 'already carries a ledger entry'],
];

const UNPOST_PAYROLL_RUN_EDITS: Edit[] = [
  // unpost is a live button (src/lib/payroll.ts:141). Without the reversal,
  // unpost -> re-post orphans the first entry and 6200 reads double the wages
  // actually paid, WITH THE TRIAL BALANCE STILL ZERO.
  ['20260908000500', 'unposting reverses the entry rather than orphaning it', 'reverses_entry_id'],
  // The mirror's lines are NEGATED. A reversal that copied them unchanged nets
  // to double rather than to nothing, and every per-entry check still passes.
  ['20260908000500', 'the reversal mirrors the lines, negated', '-amount_cents'],
  // A reversal carries the SAME SOURCE as the entry it reverses, so a reader
  // filtering the payroll source sees both halves of the pair. See the plan's
  // Global Constraints; edit_sale and delete_sale follow the same rule.
  ['20260908000500', 'the reversal is filed under the source it reverses', "'payroll', 'posted'"],
  // Clearing the pointer is what lets the run be posted again without doubling
  // 6200 -- the other half of post_payroll_run's refusal above.
  ['20260908000500', 'the pointer is cleared so a re-post cannot double 6200', 'journal_entry_id = null'],
  ['20260908000500', 'a reversal whose period has closed is redated, not refused', 'v_old_period_status'],
];

const DELETE_SALE_EDITS: Edit[] = [
  ['20260810000100', 'stock goes back to the location it came off', 'product_location_stock'],
  ['20260820000100', 'a clawback never drives the balance negative', 'greatest(coalesce(v_balance, 0), 0)'],
  // The C3 of the phase 2b final review. sales.journal_entry_id carries no ON
  // DELETE, so before this the entry outlived the sale -- still posted,
  // described by a uuid resolving to nothing -- and the backfill can never
  // repair it because there is no source row left to replay.
  ['20260908000900', 'deleting a sale reverses its journal entry', 'reverses_entry_id'],
  // sale_payments and refunds both CASCADE off sales, so their entries are
  // orphaned by the same delete. Reversing only the sale's own entry MOVES the
  // problem: the refund's 4100 and the settlement's Dr Cash / Cr 1100 would be
  // left standing over nothing and 1100 would go permanently negative.
  ['20260908000900', "the refunds' entries are reversed too", 'from public.refunds r'],
  ['20260908000900', "the settlements' entries are reversed too", 'from public.sale_payments sp'],
  // Read off the original row, never written as a literal: the three kinds are
  // three different sources ('sale', 'refund', 'settlement') and one literal
  // would be wrong for two of them.
  ['20260908000900', 'a reversal carries the source of the entry it reverses', 'v_dead.source, '],
  // The row is locked before its entry ids are read, or two concurrent deletes
  // both write a reversal and the original is reversed twice.
  ['20260908000900', 'the sale row is locked before its entry ids are read', 'where id = p_sale_id for update'],
  // sales.edit, never a ledger permission -- which is why the reversal is
  // written out inline rather than through reverse_journal_entry.
  ['20260908000900', 'deleting a sale needs sales.edit, not ledger.post', "'sales.edit'"],
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

// The last two functions in this file that carried posting code and were not
// guarded, added at the final re-review.
//
// post_expense_to_ledger has been re-created IN FULL twice already
// (20260908000750, then 20260908000800) and its entire value is a branch: WHICH
// account code each of seven arms picks. A copy-forward from 20260908000750
// silently restores the C1 and C2 double-posts -- inventory recognised twice on
// every delivery, shrinkage doubled on every stock-take -- and the C4 hole where
// a bill's cost reaches no account at all. Every entry balances in all three
// cases, so the trial balance stays at zero and nothing else in the system goes
// red. Only verify-posting-expenses.sql catches it, and that needs a running
// database; this catches it in `npm test`, from the SQL text.
//
// Every token below was checked against the COMMENT-STRIPPED body before being
// written down: this function explains each of its branches at length, so a
// token that matched the prose would survive the defect it was meant to catch.
const POST_EXPENSE_TO_LEDGER_EDITS: Edit[] = [
  ['20260908000750', 'a payroll-linked row posts nothing', 'new.payroll_run_id is not null then return null'],
  ['20260908000750', 'a row already carrying an entry posts nothing', 'new.journal_entry_id is not null then return null'],
  // The wallet the money actually left, not 1000 Cash for everything.
  ['20260908000750', "the credit is the payment method's wallet", 'public.account_code_for_payment_method(new.payment_method)'],
  // occurred_on, not today: a receipt logged days late is still the purchase
  // date's cost. And a month that has since closed redirects rather than
  // raising, or an ordinary back-dated expense insert starts failing outright.
  ['20260908000750', 'the entry is dated occurred_on', 'new.occurred_on'],
  ['20260908000750', 'an expense whose period has closed is redated, not refused', 'select status into v_period_status'],
  // 'bill', not 'payment' -- record_invoice_payment owns 'payment' for a
  // structurally different entry (Dr 2000, no expense line at all).
  ['20260908000750', "the entry's source is 'bill'", "'bill');"],
  // AFTER INSERT, so `new` is not writable and the pointer goes on with an
  // UPDATE. An assignment here is silently discarded.
  ['20260908000750', 'the row is pointed at its entry', 'update public.expenses set journal_entry_id = v_entry_id where id = new.id;'],
  ['20260908000800', 'a count-linked row posts nothing', 'new.stock_count_id is not null then return null'],
  // C1. A receipt-linked row SETTLES the payable receive_stock raised. Debiting
  // 1200 again recognises the goods twice and never clears the liability.
  ['20260908000800', 'a receipt-linked row settles the payable rather than buying the goods again', 'elsif new.stock_receipt_id is not null then'],
  ['20260908000800', 'the receipt-linked entry says the delivery was paid', "'Delivery paid'"],
  // C2. A standalone write-off comes out of INVENTORY, never a wallet: losing
  // stock costs the shop the stock, not the till.
  ['20260908000800', 'a standalone stock_loss credits 1200, never a wallet', "elsif new.category = 'stock_loss' then"],
  ['20260908000800', 'the stock_loss contra is 1200 Inventory', ":= '1200';"],
  // C4, the final re-review. A bill's mirrored row is where its cost is
  // recognised -- nothing on this branch posts when an `invoices` row is
  // inserted. Skipping it left Accounts Payable negative by every non-stock
  // bill the shop entered, with the P&L short by the same amount.
  ['20260908000800', 'a bill recognises its cost against 2000 Accounts Payable', 'if new.invoice_id is not null then'],
  ['20260908000800', "the bill's credit is 2000, not the wallet its 'other' method maps to", "'Owed to supplier'"],
  // ...and the one bill that still posts nothing, because receive_stock already
  // debited 1200 against 2000 for the same goods.
  ['20260908000800', 'an inventory_purchase bill posts nothing', "new.category = 'inventory_purchase' then return null"],
  // 20260908001900. The category was a GUESS about something the database was
  // never told, and it is wrong in both directions -- a goods bill with no
  // delivery drives Accounts Payable into debit, and a bill FOR goods entered
  // under `supplies` posts its cost on top of the delivery's and doubles the
  // payable. Both close by asking the bill which delivery it pays for.
  ['20260908001900', 'a bill is asked which delivery it pays for', 'select i.stock_receipt_id into v_bill_receipt'],
  // AND THE ANSWER IS TAKEN BEFORE THE CATEGORY IS LOOKED AT. That ordering is
  // the whole of the over-stated fix: whatever was tapped on the picker, a bill
  // that names a delivery is for that delivery. Losing this line puts Dr 6400 /
  // Cr 2000 back on top of every mis-categorised goods bill, balanced, with the
  // trial balance still at zero.
  ['20260908001900', 'a bill that names its delivery posts nothing, whatever its category', 'if v_bill_receipt is not null then return null; end if;'],
];

// The door, added by 20260908001900. It is the reason the arm above it can be an
// ADMITTED GAP rather than a claim: an inventory_purchase bill that names no
// delivery cannot be created any more, so the rows that reach that arm are only
// ones entered before it existed. Every raise here is load-bearing and each one
// fails silently in a different way if it goes.
const GUARD_INVOICE_DELIVERY_LINK_EDITS: Edit[] = [
  // Gated on the module first, or a shop that cannot record a delivery at all
  // would be unable to enter a stock-purchase bill it really does owe.
  ['20260908001900', 'a goods bill must name a delivery, where deliveries are possible', "new.category = 'inventory_purchase' and public.shop_has_module(new.shop_id, 'inventory')"],
  // SECURITY DEFINER, so without the shop test a caller who guessed a uuid could
  // probe another tenant's deliveries through the error messages.
  ['20260908001900', "the delivery must belong to the bill's own shop", 'v_receipt_shop is distinct from new.shop_id'],
  // An uncosted delivery reached no book, so there is no payable for the bill to
  // settle -- the closed defect, reached through the new column.
  ['20260908001900', 'an uncosted delivery cannot be named', 'if v_value_cents = 0 then'],
  // THE LINK IS FINAL. If it could move, the live entry was written under one
  // answer while the replay reads another, for the same row.
  ['20260908001900', 'the link cannot be changed after the bill is entered', "if tg_op = 'UPDATE' then"],
];

// backfill_shop_ledger is guarded for the same reason and one stronger: THE
// REPLAY AND THE LIVE PATH MUST AGREE, which is the property the whole of phase
// 2b turns on. Every branch below has a twin in post_expense_to_ledger or in one
// of the posting RPCs, and a copy-forward that loses one of them makes a shop's
// books change shape on the day it is migrated -- while both paths still balance
// and the trial balance still zeroes.
const BACKFILL_SHOP_LEDGER_EDITS: Edit[] = [
  // References come from the counter, never from count(*), or replayed entries
  // take numbers a live sale is about to reuse.
  ['20260908000700', 'references come from journal_entry_sequences', 'public.journal_entry_sequences'],
  // journal_entry_reference, not an inline lpad: lpad(n, 4, '0') TRUNCATES past
  // 9999, and a backfill is exactly where a shop crosses it for the first time.
  ['20260908000700', 'references go through journal_entry_reference, not an inline lpad', 'public.journal_entry_reference(v_year'],
  // A missing account raises BY NAME rather than silently dropping a line and
  // leaving an entry that still balances with its COGS at zero.
  ['20260908000700', 'a missing account stops the replay by name', 'public.backfill_missing_account('],
  // Only SETTLEMENT rows carry their own entry; complete_sale folds a sale's
  // till payments into the sale's entry and leaves those rows null for ever.
  ['20260908000700', 'only settlements are replayed from sale_payments', 'and sp.is_settlement'],
  ['20260908000700', 'entries are dated on the source row in shop-local time', 'public.shop_local_date(s.created_at)'],
  ['20260908000700', 'a payroll-linked expense row is not replayed', 'and e.payroll_run_id is null'],
  ['20260908000800', 'a count-linked expense row is not replayed', 'and e.stock_count_id is null'],
  ['20260908000800', 'a receipt-linked expense row settles 2000 rather than debiting 1200', "when e.stock_receipt_id is not null then '2000'"],
  ['20260908000800', 'a standalone stock_loss debits 5100', "then '5100'"],
  ['20260908000800', 'a standalone stock_loss credits 1200, never a wallet', "when e.stock_receipt_id is null and e.category = 'stock_loss' then '1200'"],
  ['20260908000800', "the credit is the row's own wallet, not 1000 for everything", 'public.account_code_for_payment_method(e.payment_method)'],
  // The C4 pair, and the two halves must move together: the row is replayed
  // (the filter) AND it credits 2000 rather than the 1010 Bank its literal
  // 'other' payment_method maps to (the branch).
  // TWO TOKENS, because the property is the NARROWING and the opening of the
  // exclusion does not carry it. 20260908001900 widened what is inside the
  // brackets, so the whole original token no longer appears -- but the opening
  // on its own (`and not (e.invoice_id is not null`) is satisfied by
  // `and not (e.invoice_id is not null)`, which excludes EVERY bill from the
  // replay: the exact opposite of what this entry is here to pin, and green.
  // The second token is the narrowing half, and it is the one that fails if the
  // brackets ever collapse back to "no bill is replayed".
  ['20260908000700', "a bill's mirrored expense row IS replayed", 'and not (e.invoice_id is not null'],
  ['20260908000700', 'and the exclusion stays NARROW -- some bills, not every bill', "and (e.category = 'inventory_purchase'"],
  ['20260908000700', 'a replayed bill credits 2000 Accounts Payable, not a wallet', "when e.invoice_id is not null then '2000'"],
  // 20260908001900, and its twin lives in post_expense_to_ledger above. THE
  // REPLAY AND THE LIVE PATH MUST AGREE: a bill that names its delivery posts
  // nothing live, so replaying it would give a migrated shop a 6400 and a second
  // 2000 that a shop trading today does not have. Both entries balance either
  // way. verify-backfill check 22 builds the same shop twice and compares them.
  ['20260908001900', 'a bill that names its delivery is not replayed either', 'bi.stock_receipt_id is not null'],
  // The per-shop lock and the eight back-link re-checks are asserted from the
  // LIVE function source by verify-backfill.sql check 14, which is the stronger
  // home for them. This one entry is here because it is the cheapest to lose in
  // a copy-forward and the most expensive to be without.
  ['20260908000700', 'the replay is serialised per shop', 'pg_advisory_xact_lock(74921'],
  // THE OPENING BALANCE. There is no source row for stock that was already on
  // the shelf when the shop started using kaiibi -- a product created with
  // `stock: 40` writes no stock_receipts row -- so the replay recorded that
  // stock LEAVING and nothing arriving, and 1200 Inventory sat in credit with
  // the trial balance at zero. Three tokens, because losing any one of them
  // brings the negative asset back in a different way.
  ['20260908001300', 'the opening stock balance is posted', "'Opening stock', 'opening', 'posted'"],
  ['20260908001300', 'its amount is the gap between the shelf and the ledger', 'public.opening_inventory_gap(p_shop_id)'],
  ['20260908001300', 'it is dated where the ledger begins, never the day of the run', 'public.opening_inventory_date(p_shop_id)'],
  // ...and the early `if v_written = 0 then return 0` MUST NOT COME BACK. It
  // was an optimisation over statements that are already no-ops on an empty
  // map, and it skips the opening balance entirely -- which is precisely the
  // state the shop this was found on is in: already backfilled, nothing left
  // unposted, and 1200 still negative.
  //
  // NOT EXPRESSIBLE HERE, because this file asserts the PRESENCE of a token and
  // that one is about an absence. It is asserted behaviourally instead, by
  // verify-backfill.sql check 21: a shop whose only work is its opening balance
  // -- no sales, no deliveries, nothing in _bf_map at all -- must have one
  // entry written for it, and an early return makes that check read 0.
];

// The two doors that MUTATE or DESTROY a row which has already posted, added by
// 20260908001000. Both write a reversal INLINE rather than through
// reverse_journal_entry -- which gates on ledger.post, a permission neither
// door's user holds -- so every property of a correct reversal lives in their
// own bodies and a copy-forward from an older ancestor takes it out silently.
// Losing any one of these leaves entries that still balance individually, so
// the trial balance goes on zeroing and nothing else in the system goes red.
const REVERSE_EXPENSE_ENTRY_EDITS: Edit[] = [
  // A row that posted NOTHING -- count-linked, payroll-linked, an
  // inventory_purchase bill, or an expense entered before 20260908000750
  // shipped -- has a null pointer. Reversing nothing must be a clean no-op, or
  // deleting a stock-take's write-off row starts failing outright.
  ['20260908001000', 'a row that posted nothing is a no-op, not an error', 'if old.journal_entry_id is null then'],
  // `shops` is the cascade root and BOTH expenses and journal_entries hang off
  // it. A cascade is an AFTER DELETE trigger on the parent, so the shops row is
  // already gone by the time this fires and inserting a reversal that references
  // it violates the foreign key -- taking the whole shop deletion with it.
  ['20260908001000', 'a shop being deleted writes no mirror entry', 'from public.shops where id = old.shop_id'],
  // THE ONE ENTRY THAT WAS DELETED, AND THE ONLY ONE. 20260908001000 originally
  // carried a third skip -- `if tg_op = 'DELETE'` and any of the four link
  // columns set -- so a bill's mirrored row cascading away left its Dr 6xxx /
  // Cr 2000 standing for ever with no source row. That was sound only for a
  // bill paid IN FULL, and it is not sound at all now that
  // reverse_invoice_payment_entry reverses the payments on the same cascade.
  // It is recorded here rather than silently dropped so the next reader does not
  // put it back: the pairing below is what replaced it.
  //
  // The mirror's lines are NEGATED. A reversal that copied them unchanged nets
  // to double rather than to nothing, and every per-entry check still passes.
  ['20260908001000', 'the reversal mirrors the lines, negated', '-amount_cents'],
  // Read off the original, never written as a literal: a reversal files under
  // the same source as the entry it reverses.
  ['20260908001000', 'the reversal is filed under the source it reverses', "v_old.source, 'posted'"],
  ['20260908001000', 'the original is marked reversed and linked to its mirror',
    "set status = 'reversed', reverses_entry_id = v_reversal_id"],
  // THE OTHER HALF OF AN EDIT. Clearing the pointer is what lets
  // post_expense_to_ledger -- whose first act is to skip any row that already
  // carries an entry -- post the replacement on the AFTER trigger. Without it an
  // edit reverses and never re-posts, which is strictly worse than doing
  // nothing: the cost leaves the books while the receipt stays on the screen.
  ['20260908001000', 'an edit clears the pointer so the replacement can post', 'new.journal_entry_id := null'],
  ['20260908001000', 'a reversal whose period has closed is redated, not refused', 'select status into v_old_period_status'],
  // The NULL-description trap 20260908000300 found the hard way: `||` with a
  // NULL operand yields NULL for the whole expression and post_journal_entry
  // then refuses the entry for having no description -- an error about
  // descriptions for a bug about dates.
  ['20260908001000', 'the redated description survives a null period status', "coalesce(v_old_period_status, 'not open')"],
];

const REVERSE_INVOICE_PAYMENT_ENTRY_EDITS: Edit[] = [
  // The other half of a deleted bill. Without it, deleting a bill reverses the
  // cost and leaves the payments' Dr 2000 / Cr wallet standing -- which is the
  // exact state the third skip removed from reverse_expense_entry used to be
  // justified by. The two only make sense as a pair.
  ['20260908001000', 'a deleted payment reverses the entry it posted', 'reverses_entry_id = v_reversal_id'],
  ['20260908001000', 'the reversal mirrors the lines, negated', '-amount_cents'],
  ['20260908001000', 'the reversal is filed under the source it reverses', "v_old.source, 'posted'"],
  // ALREADY REVERSED IS A NO-OP. delete_invoice_payment reverses inline and then
  // deletes, so this trigger fires on an entry that is already mirrored. Raising
  // there would break the Bills screen's Undo button outright.
  ['20260908001000', 'an entry already reversed is a no-op, not an error', "if v_old.status = 'reversed' then return null"],
  // A payment recorded before 20260908000500 shipped posted nothing.
  ['20260908001000', 'a payment that posted nothing is a no-op', 'if old.journal_entry_id is null then return null'],
  // A SHOP BEING DELETED WRITES NO MIRROR ENTRY. The edit is 20260908001000's
  // and stays; only the row it reads the shop from moved. It used to read the
  // ENTRY (`v_old.shop_id`), because invoice_payments had no shop_id of its own
  // -- and that is precisely what broke delete_shop in production: on a cascade
  // from `shops` the entry is destroyed BEFORE this trigger runs, so the guard
  // was reading a row that was no longer there and the function raised about a
  // missing entry instead of standing down. 20260908001600 gave
  // invoice_payments its own shop_id so the guard reads the row being deleted.
  ['20260908001000', 'a shop being deleted writes no mirror entry', 'from public.shops where id = old.shop_id'],
  // AND IT COMES BEFORE THE ENTRY IS READ, which is the whole of the fix -- a
  // guard below the lookup never gets to run, because the lookup is what fails.
  // Pinned as the join between the two, not as either one alone: both halves
  // were present in the broken version, in the wrong order.
  [
    '20260908001600',
    'the shop guard runs before the entry is looked up',
    'where id = old.shop_id) then\n    return null;\n  end if;\n\n  select * into v_old',
  ],
  ['20260908001000', 'a reversal whose period has closed is redated, not refused', 'select status into v_old_period_status'],
  ['20260908001000', 'the redated description survives a null period status', "coalesce(v_old_period_status, 'not open')"],
];

// The delivery side of the same door, added by 20260908001500. `stock_receipts`
// has no delete policy and no client delete today, so this is the one reversal
// in the set that was built BEFORE its hole opened -- which makes it the easiest
// to lose, because nothing in the app exercises it. Losing any entry here leaves
// 1200 Inventory carrying stock that is not on the shelf and 2000 Accounts
// Payable carrying money owed for a delivery the shop says never arrived, with
// every entry still balancing and the trial balance still zeroing.
const REVERSE_STOCK_RECEIPT_ENTRY_EDITS: Edit[] = [
  ['20260908001500', 'a deleted delivery reverses the entry it posted', 'reverses_entry_id = v_reversal_id'],
  ['20260908001500', 'the reversal mirrors the lines, negated', '-amount_cents'],
  ['20260908001500', 'the reversal is filed under the source it reverses', "v_old.source, 'posted'"],
  ['20260908001500', 'the original is marked reversed and linked to its mirror',
    "set status = 'reversed', reverses_entry_id = v_reversal_id"],
  // An UNCOSTED delivery posts no entry at all -- an ordinary delivery, not an
  // edge case. Raising here would make deleting one fail outright.
  ['20260908001500', 'a delivery that posted nothing is a no-op', 'if old.journal_entry_id is null then return null'],
  // Reachable from the manual ledger screen's void, and from every call of a
  // future Delete Delivery RPC that reverses inline before deleting -- the shape
  // delete_invoice_payment already has.
  ['20260908001500', 'an entry already reversed is a no-op, not an error', "if v_old.status = 'reversed' then return null"],
  // TODAY THIS IS THE ONLY ROUTE INTO THE TRIGGER AT ALL. stock_receipts.shop_id
  // cascades from `shops`, the cascade is an AFTER trigger on the parent, and
  // journal_entries.shop_id is not deferrable -- so a mirror entry written here
  // aborts the whole shop deletion. Read off old.shop_id: stock_receipts carries
  // one, unlike invoice_payments.
  ['20260908001500', 'a shop being deleted writes no mirror entry', 'from public.shops where id = old.shop_id'],
  ['20260908001500', 'a reversal whose period has closed is redated, not refused', 'select status into v_old_period_status'],
  ['20260908001500', 'the redated description survives a null period status', "coalesce(v_old_period_status, 'not open')"],
];

const DELETE_INVOICE_PAYMENT_EDITS: Edit[] = [
  // Recomputed from the surviving rows rather than by subtracting the deleted
  // amount, so a double-undo cannot drive the total negative.
  ['20260804000600', 'the total is recomputed from what survives, not by subtraction',
    'select coalesce(sum(amount_cents), 0) into v_remaining'],
  // The parent is locked before either table is touched, so a concurrent
  // record_invoice_payment cannot slip between the delete and the recount -- and
  // two concurrent undos cannot both write a mirror of the same entry.
  ['20260804000600', 'the parent bill is locked before either table is touched',
    'from public.invoices where id = v_invoice_id for update'],
  ['20260804000600', 'the door gates on invoices.manage', "'invoices.manage'"],
  // BEFORE the delete, and it has to be: once the invoice_payments row is gone
  // there is nothing left to read the entry id from and the entry is
  // unreachable for ever.
  ['20260908001000', 'the entry id is read before the row is deleted',
    'select invoice_id, journal_entry_id into v_invoice_id, v_entry_id'],
  ['20260908001000', 'undoing a payment reverses its entry', 'reverses_entry_id'],
  ['20260908001000', 'the reversal mirrors the lines, negated', '-amount_cents'],
  ['20260908001000', 'the reversal is filed under the source it reverses', "v_old.source, 'posted'"],
  ['20260908001000', 'a reversal whose period has closed is redated, not refused', 'select status into v_old_period_status'],
  ['20260908001000', 'the redated description survives a null period status', "coalesce(v_old_period_status, 'not open')"],
];

// post_journal_entry and open_period_for join this file at their SECOND and
// THIRD definitions respectively, which is the point at which a copy-forward
// can start losing things.
//
// post_journal_entry is the only door into the ledger and every posting RPC
// calls it. 20260908000150 replaced its racing `count(*) + 1` reference with a
// counter; 20261002000100 gave it `p_adjusting`. A copy taken from
// 20260904000500 restores the race at the till, and a copy taken from
// 20260908000150 silently removes the only way an owner can post a late bill
// into a month that has closed -- with no test in this file to say so until
// now.
const POST_JOURNAL_ENTRY_EDITS: Edit[] = [
  ['20260904000500', 'manual entries need ledger.post, and only manual ones',
    "p_source = 'manual' and not has_shop_permission(p_shop_id, 'ledger.post')"],
  ['20260904000500', 'an entry that does not balance is refused, naming the difference',
    'debits and credits differ by'],
  ['20260904000500', 'an unknown account code is named back to the caller', 'No such account'],
  ['20260904000500', 'the period gate decides whether the month accepts it', 'open_period_for'],
  // The PROPERTY, not merely a mention of the table: the counter is read and
  // incremented in ONE statement, which is what serialises two concurrent
  // posts. A read followed by a write is the race all over again.
  ['20260908000150', 'the reference comes from a counter, in one statement',
    'on conflict (shop_id, year) do update set next_number'],
  // Specific to the FORWARDING, not to the parameter existing. A copy that
  // declares p_adjusting and then calls open_period_for with two arguments
  // compiles, gates nothing, and refuses every adjusting entry.
  ['20261002000100', 'a deliberate adjusting entry reaches the period gate',
    'public.open_period_for(p_shop_id, p_entry_date, p_adjusting)'],
  // THE TENANT BOUNDARY. This function is security definer and granted to
  // `authenticated`, and for its whole life the only gate on it applied to
  // p_source = 'manual' -- so any other source let a logged-in stranger write
  // entries into any shop. Pinned as the WHOLE predicate: a copy that keeps
  // is_shop_member but drops `auth.uid() is not null` breaks every backend
  // insert, and one that keeps the uid test alone gates nothing at all.
  ['20261005000100', 'every source needs a member of the shop, not just manual',
    'auth.uid() is not null and not public.is_shop_member(p_shop_id)'],
];

const OPEN_PERIOD_FOR_EDITS: Edit[] = [
  ['20260904000200', 'a month is opened on first use rather than seeded',
    'on conflict (shop_id, starts_on) do update'],
  // Locked is checked FIRST and SEPARATELY. Folded into the closed branch it
  // becomes re-openable by an adjusting entry, which is the one thing locked
  // exists to prevent.
  ['20261002000100', 'locked refuses everything, ahead of and apart from closed',
    "if v_status = 'locked' then"],
  ['20261002000100', 'a closed month still accepts a deliberate adjusting entry', 'p_adjusting'],
  // ledger.close, never ledger.post: ordinary posting is precisely what a
  // closed period refuses, so gating the adjusting door on it permits everyone
  // who could already post.
  ['20261002000100', 'and only from somebody who may close the month',
    "has_shop_permission(p_shop_id, 'ledger.close')"],
];

const CLOSE_ACCOUNTING_PERIOD_EDITS: Edit[] = [
  ['20261002000100', 'gated on ledger.close', "has_shop_permission(p_shop_id, 'ledger.close')"],
  ['20261002000100', 'serialised per shop, so two taps write one entry',
    'pg_advisory_xact_lock(74922'],
  ['20261002000100', 'the period is scoped to the shop', 'id = p_period_id and shop_id = p_shop_id'],
  ['20261002000100', 'a locked period refuses harder than a closed one', "v_period.status = 'locked'"],
  ['20261002000100', 'closing a closed period is an error, not a no-op', "v_period.status = 'closed'"],
  // Each line is MINUS the balance, for every P&L type alike. Two branches that
  // are algebraically identical is a mutation that cannot redden anything.
  ['20261002000100', 'every closing line is minus the account balance',
    '(-sum(l.amount_cents))::bigint as amt'],
  // An account that traded and was fully reversed nets to zero, and
  // journal_lines refuses a zero amount.
  ['20261002000100', 'an account with a zero balance gets no line',
    'having sum(l.amount_cents) <> 0'],
  ['20261002000100', 'the close reads only posted and reversed lines, never drafts',
    "e.status in ('posted', 'reversed')"],
  ['20261002000100', 'a month that did not trade closes with no entry at all',
    'if v_lines is null then'],
  ['20261002000100', 'a month that broke even gets no 3900 line', 'if v_sum <> 0 then'],
  ['20261002000100', "the entry is dated the period's last day", 'v_period.ends_on'],
  // ── Task 3 (20261003000100) added these three and nothing pinned them ────
  //
  // p_force shipped ACCEPTED AND UNREAD in 20261002000100, so a copy taken from
  // that ancestor still compiles, still takes the parameter, and silently
  // closes over every outstanding item without ever refusing -- which is the
  // whole of the 'ask' mode gone, with no error anywhere.
  ['20261003000100', 'an un-forced close REFUSES while anything is outstanding',
    'if v_exceptions is not null and not p_force then'],
  // KNOWN LIMIT, stated rather than left to be discovered: this token, the
  // 'event' one and the 'forced' one each appear TWICE in the function -- once
  // in the no-trading branch and once in the ordinary one -- so an entry here
  // catches a copy that lost them ALTOGETHER and not a copy that lost one
  // branch's. The per-branch guard is verify-period-exceptions-and-auto-close
  // H1/H2, which closes a month that never traded and asserts the exceptions
  // and the audit row it wrote. Pinning them per-branch would mean pinning
  // indentation, which a reformat would turn red for no reason.
  ['20261003000100', 'what was outstanding is recorded against the period',
    'exceptions = v_exceptions'],
  // 'event' is what tells the explicit audit row apart from the trigger's
  // row-diff twin. Without it listPeriodCloseEvents() matches both, every closed
  // month appears twice, and the By column on the Close a Period screen picks
  // whichever came back first.
  ['20261003000100', 'the explicit audit row says which event it records',
    "'event', 'close'"],
  ['20261003000100', 'the audit row records whether the close was forced', "'forced', p_force"],
  // ── The final review of phase 3b (20261005000000) ───────────────────────
  //
  // A month that has not ENDED must not close. Closing the current month stops
  // the till: phase 2b's escape from a closed month is to redate the posting to
  // today, and when the closed month is the current month, today is inside it
  // and open_period_for raises. Pinned on the comparison itself -- `ends_on`
  // alone appears four times in this function, and `shop_local_date` would
  // survive a mutation to now()::date only if it were spelled out with it.
  ['20261005000000', 'a period that has not ended cannot be closed',
    'v_period.ends_on >= public.shop_local_date()'],
];

// list_accounting_periods joins at its SECOND definition, which is the point at
// which a copy-forward can start losing things. It is the ONLY door through
// which anything reads a shop's periods, and it is also where auto-close lives:
// a copy taken from 20261003000100 restores a read gate that refuses the very
// role the Close a Period screen is gated on, and a copy that drops the
// `perform close_due_periods` line turns auto-close off entirely with every
// other check in this repo still green -- there being no scheduler, that line is
// the whole feature.
const LIST_ACCOUNTING_PERIODS_EDITS: Edit[] = [
  ['20261003000100', 'the read is what closes a due period, there being no scheduler',
    'perform public.close_due_periods(p_shop_id)'],
  ['20261003000100', 'the grace date is null unless the shop is on automatic',
    "s.auto_close_periods = 'automatic'"],
  ['20261003000100', 'outstanding is computed for open periods only',
    "case when p.status = 'open'"],
  // The STANDING entry: a re-opened month's closing entry is 'reversed', and a
  // copy that drops either half reports a rolled profit for a month that rolled
  // nothing.
  ['20261003000100', 'only a closing entry still standing counts as the roll',
    "e.status = 'posted'"],
  ['20261003000100', 'a reversal is not itself the roll', 'e.reverses_entry_id is null'],
  ['20261003000100', 'the periods are scoped to the shop', 'where p.shop_id = p_shop_id'],
  // ledger.view ALONE refused a role holding only ledger.close -- which is the
  // permission the screen calling this is gated on. Pinned as the OR predicate,
  // not merely as a mention of the permission.
  ['20261004000000', 'a role holding only ledger.close can read the list it may close',
    "has_any_shop_permission(p_shop_id, array['ledger.view', 'ledger.close'])"],
];

// reopen_accounting_period had NO entry list at all, despite two full
// definitions and an inline reversal whose every part is a decision.
const REOPEN_ACCOUNTING_PERIOD_EDITS: Edit[] = [
  ['20261002000100', 'gated on ledger.close', "has_shop_permission(p_shop_id, 'ledger.close')"],
  ['20261002000100', 'a reason is required, and whitespace is not one',
    'length(trim(p_reason)) = 0'],
  ['20261002000100', 'the period is scoped to the shop', 'id = p_period_id and shop_id = p_shop_id'],
  ['20261002000100', 'a locked period is final and refuses the re-open too', "v_period.status = 'locked'"],
  // THE ONE THAT MATTERS MOST, and the one a copy-forward would lose by
  // "simplifying" the inline build into a call to reverse_journal_entry():
  // that function files its reversal as 'manual', so a re-opened month's
  // reversal would land in the income statement as trading -- INVERTED, since
  // its lines are the negatives of a closing entry's. 20261002000100:68-82
  // writes that failure out at length and nothing guarded it.
  ['20261002000100', 'the reversal carries source = close, so it stays out of the statements',
    "'close', 'posted', v_close.location_id, v_close.id"],
  ['20261002000100', 'and its lines are NEGATED, which is what makes it a reversal',
    'account_id, -amount_cents, location_id, memo'],
  ['20261002000100', 'the original is marked reversed rather than deleted', "status = 'reversed'"],
  // The STANDING entry, so a month closed, re-opened and closed again reverses
  // the close that is actually in force.
  ['20261002000100', 'it reverses the closing entry still standing', 'reverses_entry_id is null'],
  ['20261003000100', 'the recorded exceptions are cleared, there being no close to describe',
    "exceptions = '{}'"],
  ['20261003000100', 'the audit row says which event it records', "'event', 'reopen'"],
];

// ── The three statements, and the rule this branch already lost once ───────
//
// "All three statement functions exclude source = 'close'" is phase 3b's
// central rule and it had no text-level guard -- while the branch itself
// demonstrated the failure: task 2 concluded cash_flow() needed no change and
// task 6 found that wrong. All three are now at their second definition, so the
// next copy-forward has the same opportunity and, until these entries, the same
// silence.
//
// A closing entry is a bookkeeping act, not trading. Without the exclusion an
// income statement for any window containing a close reads near zero: the close
// debits every revenue account and credits every expense account by exactly
// their balances.
const STATEMENT_LINES_EDITS: Edit[] = [
  ['20261001000000', 'gated on ledger.view, which is the whole protection',
    "has_shop_permission(p_shop_id, 'ledger.view')"],
  ['20261001000000', 'posted AND reversed, never drafts', "e.status in ('posted', 'reversed')"],
  ['20261001000000', 'the lines are scoped to the shop', 'e.shop_id = p_shop_id'],
  ['20261002000000', 'a closing entry is not trading', "e.source <> 'close'"],
];

const BALANCE_SHEET_EDITS: Edit[] = [
  ['20261001000100', 'gated on ledger.view', "has_shop_permission(p_shop_id, 'ledger.view')"],
  ['20261001000100', 'the lines are scoped to the shop', 'e.shop_id = p_shop_id'],
  // balance_sheet does NOT exclude source = 'close' the way the other two do,
  // and that is deliberate: a closing entry moves real balances (3900 gains
  // what the P&L accounts gave up). What it must not do is COUNT THE PROFIT
  // TWICE -- once in "Profit this period" and again inside 3900 -- so it
  // subtracts the P&L side of the closes instead.
  ['20261002000000', 'the profit already rolled into 3900 is taken out of profit this period',
    'v_profit := v_profit - v_closed;'],
  ['20261002000000', 'and it is the CLOSING entries that are subtracted', "e.source = 'close'"],
  // Read off the closing entries' P&L SIDE, never off 3900's balance: a shop
  // carrying pre-kaiibi retained earnings in on an 'opening' entry would have
  // that subtracted from this period's profit. See 20261002000000:304-308.
  ['20261002000000', "off the closes' P&L side, not off 3900's balance",
    "a.type in ('revenue', 'cost_of_sales', 'expense')"],
];

const CASH_FLOW_EDITS: Edit[] = [
  ['20261001000200', 'gated on ledger.view', "has_shop_permission(p_shop_id, 'ledger.view')"],
  ['20261001000200', 'the lines are scoped to the shop', 'e.shop_id = p_shop_id'],
  // Task 2 concluded this one needed no change; task 6 found that wrong. A
  // forged or future close touching a cash account would otherwise move the
  // balance sheet's cash and not the cash flow's, and reconciliation 5 would
  // report a discrepancy whose cause is not in the arithmetic at all.
  ['20261004000100', 'the cash flow ignores a close too', "e.source <> 'close'"],
];

describe.each([
  ['complete_sale', COMPLETE_SALE_EDITS],
  ['reopen_accounting_period', REOPEN_ACCOUNTING_PERIOD_EDITS],
  ['statement_lines', STATEMENT_LINES_EDITS],
  ['balance_sheet', BALANCE_SHEET_EDITS],
  ['cash_flow', CASH_FLOW_EDITS],
  ['list_accounting_periods', LIST_ACCOUNTING_PERIODS_EDITS],
  ['post_journal_entry', POST_JOURNAL_ENTRY_EDITS],
  ['open_period_for', OPEN_PERIOD_FOR_EDITS],
  ['close_accounting_period', CLOSE_ACCOUNTING_PERIOD_EDITS],
  ['edit_sale', EDIT_SALE_EDITS],
  ['delete_sale', DELETE_SALE_EDITS],
  ['refund_sale_items', REFUND_SALE_ITEMS_EDITS],
  ['settle_sale_balance', SETTLE_SALE_BALANCE_EDITS],
  ['record_invoice_payment', RECORD_INVOICE_PAYMENT_EDITS],
  ['post_payroll_run', POST_PAYROLL_RUN_EDITS],
  ['unpost_payroll_run', UNPOST_PAYROLL_RUN_EDITS],
  ['receive_stock', RECEIVE_STOCK_EDITS],
  ['save_stock_count', SAVE_STOCK_COUNT_EDITS],
  ['post_expense_to_ledger', POST_EXPENSE_TO_LEDGER_EDITS],
  ['guard_invoice_delivery_link', GUARD_INVOICE_DELIVERY_LINK_EDITS],
  ['reverse_expense_entry', REVERSE_EXPENSE_ENTRY_EDITS],
  ['reverse_invoice_payment_entry', REVERSE_INVOICE_PAYMENT_ENTRY_EDITS],
  ['reverse_stock_receipt_entry', REVERSE_STOCK_RECEIPT_ENTRY_EDITS],
  ['delete_invoice_payment', DELETE_INVOICE_PAYMENT_EDITS],
  ['backfill_shop_ledger', BACKFILL_SHOP_LEDGER_EDITS],
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
