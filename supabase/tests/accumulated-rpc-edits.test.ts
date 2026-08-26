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
  // 20260929000000. A storefront order is a promise made earlier, so a line can
  // be filed at the price the customer was quoted rather than the price on the
  // shelf today.
  //
  // A NEW, DISTINCTLY-NAMED FIELD. Carts have carried `unit_price_cents` since
  // 0001 and this function has always ignored it -- verify-complete-sale-baseline
  // sends 9999 in it on EVERY cart while asserting the product's own price, so
  // that is pinned behaviour, not an accident. The token is therefore the read
  // of the new field, not the bare column name: `unit_price_cents` appears in
  // the sale_items insert either way and would be green against a function that
  // had lost the agreed price entirely.
  ['20260929000000', 'a line may be filed at the price the customer was quoted', "v_item->>'agreed_unit_price_cents'"],
  // AND coalesce, not `case when v_agreed_price > 0`. Zero is a price -- the
  // item a shop promised to throw in -- and the natural-looking version reads it
  // as "no agreed price" and charges the customer list for it. The token is the
  // resolution itself, which a rewrite cannot satisfy while getting this wrong.
  ['20260929000000', 'absent and zero are different answers', 'coalesce(v_agreed_price, v_product.price_cents)'],
  // ...and the line is computed from the resolved price. Losing this while
  // keeping the declarations leaves a function that accepts the field, files it
  // on sale_items.unit_price_cents and then charges list for it -- a receipt
  // that disagrees with the money taken, and every total still balancing.
  //
  // THE TOKEN WAS WIDENED BY 20260929000050's SECOND FIX WAVE, and the property
  // is unchanged: the same arithmetic, on the same resolved price, computed in
  // bigint so the bound below it can be reached. `v_line := v_unit_price *
  // v_qty - v_line_discount` was the 32-bit multiplication that overflowed on a
  // line priced from the shelf.
  ['20260929000000', 'the line total follows the agreed price', 'v_line_cents := v_unit_price::bigint * v_qty - v_line_discount'],
  // An agreed price and a promotion are two answers to one question: an offer is
  // a reduction OFF the list price, recomputed server-side from
  // products.price_cents, and an agreed price REPLACES the list price. Lose the
  // refusal and one of the two is silently discarded, with no way afterwards to
  // say which price the customer was actually promised. The token is the message
  // because that message is a caller's only handle on it -- complete_sale raises
  // plain P0001 and the text is what a client matches to say this in the
  // shopkeeper's own words.
  ['20260929000000', 'an agreed price alongside a promotion is refused, by name',
    "'an agreed price cannot be combined with a promotion on the same line (%)'"],
  ['20260929000000', 'a negative agreed price is refused', 'v_agreed_price < 0'],
  // Bounded on the LINE and in BIGINT, not on the unit and not in integer. A
  // unit price inside the 32-bit ceiling can still make a line outside it (3 at
  // 1,000,000,000), and unbounded that is a bare `integer out of range` thrown
  // from the middle of the register's write path with nothing to say which line.
  // The token is the whole comparison: `c_max_line_cents` alone survives a
  // rewrite that keeps the constant and tests the unit.
  ['20260929000000', 'an agreed price whose line would overflow is refused before it does',
    'v_agreed_price::bigint * v_qty > c_max_line_cents'],
  // THE COST DOES NOT MOVE. Cost is what the shop actually paid; an agreement
  // about the SELLING price says nothing about it, and deriving it from the
  // agreed price misstates COGS and every gross-profit figure downstream --
  // making stock given away look free. 20260804000000 froze this column and the
  // agreed price does not get to unfreeze it. The token is the insert's VALUES
  // list around it, not the bare `v_product.cost_cents`, so it pins the cost
  // sitting BESIDE the agreed price rather than merely being mentioned.
  ['20260929000000', 'the frozen cost still comes from the product, never the agreed price',
    'v_line, v_line_discount, v_product.cost_cents,'],
  // 20260929000050. THE ONE THAT WAS ALREADY A HOLE. 20260929000000 shipped the
  // agreed price ungated, arguing complete_sale had no signal to gate it on --
  // while calling has_shop_permission(p_shop_id, 'discounts.manual') twelve
  // statements above the block, in the same loop, for a line discount with no
  // promotion behind it. So a cashier who could not take one cent off through
  // `discount_cents` could file the whole line at one cent through
  // `agreed_unit_price_cents`: same money, same till, same person, gate gone.
  //
  // TWO TOKENS JOINED INTO ONE, because the property is the PAIRING. The
  // permission call alone already appears twice in this function and would be
  // green against a version that lost this check entirely; the comparison alone
  // is satisfiable by a rewrite that tests the direction and then does nothing
  // with the answer.
  ['20260929000050', 'an agreed price below the shelf price needs discounts.manual',
    "v_agreed_price < v_product.price_cents\n         and not public.has_shop_permission(p_shop_id, 'discounts.manual')"],
  // ...and it is refused BY NAME. complete_sale raises plain P0001, so the text
  // is a caller's only handle -- and Task 4's storefront fulfilment is the
  // caller that will meet it, when a shop raised a price after an order was
  // placed. The product name is last so the prefix stays matchable.
  ['20260929000050', 'the undercut refusal names itself so a client can say it',
    "'not authorized to file a line below the shelf price (%)'"],
  // BIGINT AT THE PARSE. As `::integer` this line raised
  // `value "3000000000" is out of range for type integer` -- a Postgres cast
  // error naming a type -- one statement BEFORE the bound that exists to turn
  // exactly that into a sentence. The bound was unreachable for every value it
  // was written to catch.
  ['20260929000050', 'the agreed price is parsed wide enough for its own bound to be reached',
    "nullif(v_item->>'agreed_unit_price_cents', '')::bigint"],
  // ...and narrowed only AFTER the bound has passed. The token carries the cast
  // rather than the coalesce alone (which the 20260929000000 entry above already
  // pins), because a rewrite that moves the narrowing back up to the parse
  // satisfies the coalesce and restores the defect.
  ['20260929000050', 'and narrowed to integer only after the bound has passed',
    'coalesce(v_agreed_price, v_product.price_cents)::integer'],
  // THE PER-LINE BOUND IS NOT THE SALE'S. Three lines of 1,000,000,000 each pass
  // the line bound individually -- that is what per-line means -- and then
  // overflow `v_gross_cents integer` in the accumulation, giving the caller the
  // bare `integer out of range` from mid-function that the line bound's own
  // comment claimed to prevent. The token is the widened comparison: the bare
  // constant survives a rewrite that declares it and never tests against it.
  //
  // THE CONSTANT IN IT IS c_max_int_cents, NOT c_max_sale_cents, and that is the
  // second fix wave. c_max_sale_cents was 1,000,000,000 -- the AGREED price's
  // ceiling -- applied to the running total of every line, so a plain till sale
  // of a 1,500,000,000 product with no agreed price anywhere, which the register
  // accepted before this branch because it fits in an integer, came back
  // `this sale is out of range`. The token pins the corrected pairing, because
  // the comparison alone is satisfiable by one measured against the wrong bound.
  ['20260929000050', 'the running total cannot overflow either',
    'v_gross_cents::bigint + v_line_cents > c_max_int_cents'],
  // ...and neither can a SINGLE line priced from the shelf. Only the agreed
  // price was bounded before its own multiplication; a product priced
  // 1,500,000,000 with a quantity of 3 and no agreed price overflowed
  // `v_unit_price * v_qty` and raised a bare `integer out of range` from
  // mid-loop.
  //
  // THE COMPARISON JOINED TO ITS OWN RAISE, and the bare comparison was tried
  // first and rejected by mutation: `v_line_cents > c_max_int_cents` is a
  // SUBSTRING of the running-total test three statements below
  // (`v_gross_cents::bigint + v_line_cents > c_max_int_cents`), so deleting this
  // bound outright left the entry green on the other one's text. Joined to the
  // message, it can only be satisfied by the statement it is about.
  ['20260929000050', 'a line priced from the shelf cannot overflow either',
    "if v_line_cents > c_max_int_cents then\n      raise exception 'this line is out of range"],
  // THE TWO BOUNDS ARE DIFFERENT FIGURES ON PURPOSE, and collapsing them is the
  // regression fix wave 2 repaired. 2,147,483,647 is where `v_line integer` and
  // `v_gross_cents integer` stop holding the answer -- so nothing that ever
  // succeeded can reach it and a crash becomes a sentence. 1,000,000,000 is a
  // distrust of a caller's number and belongs only where one arrives. A rewrite
  // that sets this constant to the agreed price's ceiling refuses ordinary till
  // sales the register has always accepted; baseline check 23 is the other half
  // of this guard.
  ['20260929000050', 'the arithmetic ceiling is int32, not the agreed price ceiling',
    'c_max_int_cents constant bigint := 2147483647'],
  // 20260929000100. A STOREFRONT QUOTES A TOTAL AND THE CUSTOMER ACCEPTS IT, so
  // completing that order at a tax-charging shop must charge the figure that was
  // agreed -- the tax comes OUT of it rather than being added on top of it.
  //
  // THE PARAMETER AND ITS COALESCE IN ONE TOKEN, because the coalesce is the
  // half that costs money if it goes. The flag arrives from a caller and a
  // caller can send an explicit NULL; read raw, `if not p_prices_include_tax` is
  // NULL rather than TRUE for such a call, the add-on branch is skipped, and the
  // sale goes out UNTAXED with nothing said about it. The bare parameter name
  // would be green against exactly that.
  ['20260929000100', 'a caller may say the prices already include tax, and a null flag is not one',
    'v_prices_include_tax boolean := coalesce(p_prices_include_tax, false)'],
  // THE TAX IS WHAT ROUNDS, and this is the substance of the change rather than
  // a detail of it. Extraction is not the inverse of addition: at a gross of
  // 1001 and a rate of 4% the exact net is 962.5 and the exact tax 38.5, so
  // rounding the TAX gives 39 and rounding the NET gives 38 -- the same sale, a
  // cent apart. The till rounds the tax (`round(v_total_cents * v_tax_rate /
  // 100)`), so a quoted sale rounds the same quantity, or 2100 and 4000 stop
  // reconciling by a cent per order. The token is the whole expression: the
  // variable name survives a rewrite that rounds the net into it. Baseline check
  // 27a is the behavioural half.
  ['20260929000100', 'the tax is extracted by rounding the TAX, not the net',
    'round(v_total_cents * v_tax_rate / (100 + v_tax_rate))'],
  // ...AND IT LEAVES THE RUNNING TOTAL AT ONCE, which is what makes the rest of
  // the function need no second branch. From this statement on v_total_cents is
  // the tax-exclusive merchandise figure in both directions, so the loyalty earn
  // below it is the SAME LINE it has always been and a quoted sale earns on the
  // same kind of figure a counter sale does. Lose this and the quote is charged
  // with its own tax added on top of itself AND the customer earns points on the
  // state's share.
  ['20260929000100', 'the extracted tax comes back out of the running total, before the points are earned',
    'v_total_cents := v_total_cents - v_included_tax_cents;'],
  // ...and the tax is NOT then added on top as well. The token is the guard
  // joined to the statement it guards, so it cannot be satisfied by a rewrite
  // that keeps the till's line and drops the condition -- which is the whole
  // defect: the customer is billed the quote plus tax on the quote.
  ['20260929000100', 'a quoted sale is not taxed on top as well',
    'if v_tax_enabled and not v_prices_include_tax then\n    v_tax_cents := round(v_total_cents * v_tax_rate / 100)::integer;'],
  // REVENUE IS CREDITED NET OF THE TAX INSIDE THE QUOTE, and this one is not a
  // presentation choice: the debits come to G + I and crediting revenue at G + I
  // alongside the state's T leaves the entry heavier by exactly T, so
  // post_journal_entry refuses it and a tax-charging shop cannot complete a
  // quoted order AT ALL. The token is the negated amount rather than the bare
  // subtraction, so it pins the figure that actually reaches the journal line.
  ['20260929000100', 'revenue is credited net of the tax that was inside the quote',
    '-(v_gross_cents + v_item_discount_cents - v_included_tax_cents)'],
  // TWO ENTRIES WERE DELETED HERE BY 20260929000150, and they are written out
  // rather than removed silently so the next reader does not put them back.
  //
  // 20260929000100 gated the tax-inclusive flag itself on `discounts.manual`
  // -- refused at a tax-charging shop with `not authorized to file a sale at
  // prices that already include tax` -- and guarded that gate with two tokens
  // here. 20260929000150 removed the gate, so both entries went with it.
  //
  // The argument for the gate was that the flag moves what the shop KEEPS: the
  // same two items at a 5% shop collect 2520 and leave 2400 of revenue without
  // it and collect 2400 and leave 2286 with it. It does not survive the
  // payments-equality check -- a caller who sets the flag must actually COLLECT
  // the lower figure, so it is the customer paying less at the shop's own
  // published price, not the till going short -- and Task 4 makes
  // complete_storefront_order set this flag for EVERY storefront order at a
  // tax-charging shop, so the gate made ORDINARY online fulfilment need a
  // discounting permission. The whole argument is in 20260929000150's header.
  //
  // WHAT IS EMPHATICALLY NOT DELETED is the `discounts.manual` gate on an
  // UNDERCUT through `agreed_unit_price_cents`, two entries above
  // ('20260929000050'). That one is about a cashier inventing a figure at the
  // counter and it stays.
  //
  // 20260929000200. ...WITH ONE EXEMPTION, AND ONLY ONE: the shop honouring a
  // quote it published itself. A shop that RAISES a price after a customer
  // ordered makes every fulfilment of that order an undercut, so without this
  // the ordinary act of handing over a web order needs a discounting
  // permission -- the same category error 20260929000150 removed from the tax
  // flag. An order's frozen price is not a caller's number:
  // place_storefront_order reads it off products.price_cents server-side
  // (20260927000000:409).
  //
  // The token is the EXEMPTION JOINED TO THE GATE IT QUALIFIES, so it cannot
  // be satisfied by a version that keeps the table and stops asking the
  // permission question first -- which would make the lookup run for every
  // till sale and, worse, read as the primary rule.
  ['20260929000200', 'a storefront fulfilment may honour its own quote without discounts.manual',
    "and not public.has_shop_permission(p_shop_id, 'discounts.manual')\n         and not exists (\n           select 1\n             from public.storefront_order_fulfilments f"],
  // AND THE MARK IS THIS TRANSACTION'S, which is the whole reason the
  // exemption is safe to grant. Transaction ids are monotonic and never
  // reused, so a mark left behind by an earlier call authorises nothing later.
  // Lose this line and any row that survived in that table -- by a dropped
  // delete, a restore, a superuser's hand -- becomes a standing permission to
  // undercut. verify-order-transitions check 52b is the behavioural half.
  ['20260929000200', 'the fulfilment mark must be stamped by THIS transaction',
    'where f.xact_id = pg_current_xact_id()'],
  // AND IT IS NARROWED BY THE ORDER'S OWN LINES. The marked order must actually
  // carry this product at exactly this price, so a fulfilment in flight excuses
  // the prices that order quoted and nothing beside them. Without this join a
  // marked transaction could file ANY line at ANY price below the shelf.
  //
  // Not literally per line: quantity is not matched, and one mark is not
  // consumed by the call that uses it. Neither is reachable -- both need a
  // second statement inside the transaction that holds the mark, and
  // complete_storefront_order deletes it before it returns. 20260929000200's
  // header states the whole of what is and is not enforced.
  ['20260929000200', 'the exemption covers only the product and price that order quoted',
    'and oi.product_id = v_product.id\n              and oi.unit_price_cents = v_agreed_price'],
];

// complete_storefront_order joins this file at its FIFTH full reproduction,
// and it should have joined at its second.
//
// It is complete_sale's only other caller that posts money, it is re-created
// in full by every migration that touches it, and 20260929000200 gave it four
// edits the whole storefront branch rests on. The proof that this list was
// missing rather than merely absent: deleting
// `delete from public.storefront_order_fulfilments where order_id =
// p_order_id;` from that migration left ALL 216 assertions in this file green,
// while re-opening the exact undercut check 51b exists to refuse -- a cashier
// with no `discounts.manual` filing a line below the shelf price at the TILL,
// in the same transaction, on a mark this function left lying around. Only a
// database check caught it, and only after the migration had been applied.
// This file exists to fail before that.
//
// The list runs from 20260928000200, the function's first definition, not from
// Task 4 -- a copy-forward from the wrong ancestor takes out whatever it takes
// out, and "the edits Task 4 happened to make" is not a category the next
// mistake will respect.
const COMPLETE_STOREFRONT_ORDER_EDITS: Edit[] = [
  // 20260928000200, the original. The row lock is first because everything
  // below it reads v_order: without `for update` two shop phones tapping
  // "Handed over" together both read 'ready' and both post a whole sale, and
  // the status guard below -- which is what refuses the second one -- never
  // sees the first.
  ['20260928000200', 'the order row is locked before anything is decided from it',
    'from public.orders where id = p_order_id for update'],
  ['20260928000200', "an outsider cannot complete another shop's order",
    'if not public.is_shop_member(v_order.shop_id) then'],
  ['20260928000200', 'a shop without the storefront module cannot complete an order',
    "public.shop_has_module(v_order.shop_id, 'storefront')"],
  // THE GUARD JOINED TO ITS REFUSAL. The transition trigger below would also
  // refuse most of these, but NOT completed -> completed: that reaches the
  // trigger as a same-status call and is waved through, so without this guard a
  // second call posts a whole second sale. The bare status comparison would be
  // green against a version that tested it and did nothing.
  ['20260928000200', 'an order that is not ready cannot be completed, and a completed one cannot be completed twice',
    "if v_order.status <> 'ready' then\n    raise exception 'invalid_order_transition'"],
  // 'unpaid' is deliberately NOT in the list: an order handed over at the door
  // has been paid for, and this function has no customer record to leave a
  // balance against. Checked here rather than left to complete_sale, so getting
  // it wrong costs no stock decrement first.
  ['20260928000200', 'the payment method is a closed list, checked before anything is written',
    "p_payment_method not in ('cash', 'zaad', 'edahab', 'other')"],
  // THE SNAPSHOT, not a fresh product lookup -- the property the whole feature
  // is built on. The token is the aggregate's tail rather than the table name:
  // this function reads order_items twice (the payload, and lines_cents in the
  // order_total_changed branch), so `from public.order_items` alone would stay
  // green against a version that built the payload from products.
  ['20260928000200', "the sale is built from the order's own frozen lines",
    "order by oi.product_name), '[]'::jsonb)"],
  ['20260928000200', 'a line whose product was deleted is named, not handed to complete_sale',
    "raise exception 'order_product_deleted'"],
  ['20260928000200', 'an order with no items is refused rather than posting an empty sale',
    "raise exception 'order_has_no_items'"],
  // THE GOODS, AND ONLY THE GOODS. complete_sale refuses a payment larger than
  // the total it computed from the items, so tendering subtotal + delivery fee
  // fails every order that carries a fee. The fee's own movement is route B
  // below.
  ['20260928000200', 'the delivery fee is not tendered with the goods',
    "'amount_cents', v_order.subtotal_cents))"],
  // 4300 Delivery Income, NEVER 4000 Sales Revenue: delivery carries no cost of
  // sales, so folding it into goods revenue flatters gross margin on every
  // report. 20260928000000 created the account for exactly this.
  ['20260928000200', 'the delivery fee posts to 4300 Delivery Income, never 4000',
    "'code',         '4300',"],
  // The date is READ OFF the entry complete_sale just posted, never recomputed,
  // so it inherits both the Africa/Mogadishu rule and the closed-period
  // redirect for free. Two entries for one order in two different months is a
  // reconciliation problem with no fix once a period closes.
  ['20260928000200', "the fee entry is dated from the sale's own entry, not recomputed",
    'select je.entry_date into v_entry_date'],
  // complete_sale raises plain P0001 and the text is the only handle there is,
  // so this function turns the ones a shop can act on into codes with a JSON
  // detail. Losing the mapping puts complete_sale's raw English on the shop's
  // screen, which is what orderErrorMessage's `default: return null` does with
  // anything it does not know.
  ['20260928000200', "complete_sale's raw refusals are translated into codes a client can say",
    "raise exception 'insufficient_stock'"],
  // 20260928000400. The fee entry's id is KEPT and stamped onto the order, so
  // the entry is reachable by more than a description string -- delete_sale's
  // fourth UNION branch reverses it through this column. The token is the whole
  // SET list: it pins the id landing on the order AND the status, sale link and
  // fee link moving in ONE statement, which is also the only shape the
  // transition trigger accepts.
  ['20260928000400', 'the fee entry is linked to the order, and the whole completion lands in one statement',
    "set status = 'completed', sale_id = v_sale_id, delivery_entry_id = v_fee_entry_id"],
  // 20260928000500. Written as the table owner BEFORE the order is touched, so
  // the trigger fired by the UPDATE above finds it already there. Without it
  // that trigger cannot tell a real completion from a direct status write.
  ['20260928000500', 'the completion is provenanced before the order status moves',
    'insert into public.storefront_order_completions (order_id, sale_id)'],
  // 20260928000600. THE GATE JOINED TO ITS REFUSAL, because
  // has_shop_permission is not otherwise called in this function but a rewrite
  // that keeps the call and drops the raise is exactly the mistake this
  // catches. A member who cannot ring up a sale at the counter cannot ring one
  // up through the storefront either.
  ['20260928000600', 'completing an order needs pos.access, stated here rather than found three calls deep',
    "if not public.has_shop_permission(v_order.shop_id, 'pos.access') then\n    raise exception 'pos_access_required'"],

  // ── 20260929000200: Task 4's four load-bearing edits ─────────────────────
  //
  // Each one was bite-tested by deleting the code it guards and confirming
  // this file goes red naming the entry. They are the four that make a
  // fulfilment charge the price the customer agreed to, and each fails
  // differently and quietly if a copy-forward drops it.
  //
  // THE FIELD IS `agreed_unit_price_cents`, and `unit_price_cents` is not it.
  // Carts have carried the latter since 0001 and complete_sale has always
  // ignored it -- verify-complete-sale-baseline sends 9999 in it on every cart
  // while asserting the product's own price. The token therefore carries the
  // NEW key beside the column it is built from: the bare column name is in the
  // payload either way, and would be green against a payload that had lost the
  // agreed price entirely and gone back to charging today's shelf price.
  ['20260929000200', 'every line is sent at the price the order quoted',
    "'agreed_unit_price_cents', oi.unit_price_cents)"],
  // ...AND THE MARK THAT MAKES complete_sale ACCEPT IT. A shop that RAISED a
  // price after a customer ordered turns every fulfilment of that order into a
  // line below the shelf price, which needs `discounts.manual`
  // (20260929000050). This row is the provenance that exempts it, and it is
  // written BEFORE complete_sale runs because complete_sale is what reads it.
  // Lose it and a re-priced order is refused, at a shop whose prices are its
  // own, with a message about shelf prices that names neither orders nor
  // discounting.
  ['20260929000200', 'the fulfilment marks itself, so complete_sale can see the quote is the shop\'s own',
    'insert into public.storefront_order_fulfilments (order_id)\n    values (p_order_id)'],
  // ...AND THE MARK COMES STRAIGHT BACK DOWN. THE ONE THE REVIEW PROVED WAS
  // UNGUARDED: deleting this statement left every other assertion in this file
  // green while re-opening check 51b -- the same cashier, without
  // `discounts.manual`, undercutting the same product through complete_sale
  // DIRECTLY, later in the same transaction, on a mark this function had left
  // live. The exemption must last exactly as long as the call it exists for.
  //
  // The `where` clause is in the token, not just the table name: an unqualified
  // `delete from public.storefront_order_fulfilments` would be green here and
  // would also be a different statement.
  ['20260929000200', 'the fulfilment mark is deleted the moment complete_sale returns',
    'delete from public.storefront_order_fulfilments where order_id = p_order_id;'],
  // ...AND THE SALE IS FILED TAX-INCLUSIVE. A storefront quotes a total and the
  // customer accepts THAT total; there is no second, larger figure to collect
  // at the door. Without this a tax-charging shop cannot complete ANY order --
  // complete_sale adds the tax on top of the quote and then refuses the quoted
  // payment against its own larger total, which came back as
  // `order_total_changed`: a sentence about prices moving, given to a shop
  // whose prices had not moved. The token is the argument as it is passed,
  // trailing `);` and all, so it pins the flag actually REACHING complete_sale
  // rather than being mentioned in the comment above the call.
  ['20260929000200', 'a storefront sale is filed at prices that already include tax',
    'p_prices_include_tax  => true);'],
  // ...and what order_total_changed narrowed TO. It now fires only when the
  // order ROW disagrees with the order's own LINES, and the detail carries both
  // figures so the disagreement is legible without a second query against rows
  // that may have moved since. 20260929000250's declaration comment says why
  // this stays although no client reads it.
  ['20260929000200', "the narrowed refusal carries the order's own line total",
    "'lines_cents',  v_lines_cents,"],

  // ── 20260929000250 ───────────────────────────────────────────────────────
  //
  // Filing every line at the agreed price also puts every line behind that
  // field's per-line ceiling of 1,000,000,000 cents. order_items.line_total_cents
  // is a plain `integer`, so an order line above that ceiling is storable and
  // completed before this branch -- and after it, complete_sale's raw
  // `agreed price for X is out of range: ...` went straight to the shop's
  // screen through orderErrorMessage's `default: return null`.
  //
  // TWO ENTRIES, the match and the code, because they fail differently: a
  // rewrite that widens the pattern swallows refusals this function has never
  // seen and should have re-raised, and one that keeps the branch and changes
  // the code silently un-translates it again at the client.
  ['20260929000250', "the agreed price's own line bound is recognised, not re-raised as raw English",
    "v_msg like 'agreed price for % is out of range%' then"],
  ['20260929000250', 'and refused with a code a client can turn into a sentence',
    "raise exception 'order_line_out_of_range'"],
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

describe.each([
  ['complete_sale', COMPLETE_SALE_EDITS],
  ['complete_storefront_order', COMPLETE_STOREFRONT_ORDER_EDITS],
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
