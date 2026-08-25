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
  ['20260908000700', "a bill's mirrored expense row IS replayed", "and not (e.invoice_id is not null and e.category = 'inventory_purchase')"],
  ['20260908000700', 'a replayed bill credits 2000 Accounts Payable, not a wallet', "when e.invoice_id is not null then '2000'"],
  // The per-shop lock and the eight back-link re-checks are asserted from the
  // LIVE function source by verify-backfill.sql check 14, which is the stronger
  // home for them. This one entry is here because it is the cheapest to lose in
  // a copy-forward and the most expensive to be without.
  ['20260908000700', 'the replay is serialised per shop', 'pg_advisory_xact_lock(74921'],
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
  // Read off the ENTRY: invoice_payments has no shop_id, and on a cascade from
  // `shops` its invoice has gone too.
  ['20260908001000', 'a shop being deleted writes no mirror entry', 'from public.shops where id = v_old.shop_id'],
  ['20260908001000', 'a reversal whose period has closed is redated, not refused', 'select status into v_old_period_status'],
  ['20260908001000', 'the redated description survives a null period status', "coalesce(v_old_period_status, 'not open')"],
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

describe.each([
  ['complete_sale', COMPLETE_SALE_EDITS],
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
  ['reverse_expense_entry', REVERSE_EXPENSE_ENTRY_EDITS],
  ['reverse_invoice_payment_entry', REVERSE_INVOICE_PAYMENT_ENTRY_EDITS],
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
