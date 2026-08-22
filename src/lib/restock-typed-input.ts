// Reading what a person TYPED into the restock sheet's two number fields.
//
// These exist to hold one rule: nothing rewrites the text on its way into
// state. A controlled TextInput feeds its own value back in as the base for
// the next keystroke, so any normalisation done inside onChangeText is applied
// again to its own output -- a half-typed number gets reinterpreted before the
// person has finished typing it. That bug has shipped from this screen twice,
// in both directions: "1,50" recorded as $150.00, then "1,500" recorded as
// $1.50, because the comma was consumed at the moment it was typed and the
// digits that would have settled the reading arrived after it was gone.
//
// So the field holds the raw string, and these functions classify it once,
// where the whole string is visible: at submit, and for the delivery value the
// footer shows. Both are pure and neither one throws.
//
// Not shared with restock-import.ts's parseDollarsToCents, deliberately. That
// one reads a spreadsheet cell, which is finished text from an unknown
// producer, and it is right to be lenient about stray currency symbols and
// strict about "no digits at all". This one reads a field mid-edit on a phone
// whose keyboard may only offer a comma, and the separator question is the
// whole job.

export type TypedCost =
  // Nothing typed. The delivery does not state a cost, and products.cost_cents
  // is left exactly as it was -- distinct from "typed something we cannot read".
  | { kind: 'blank' }
  | { kind: 'cents'; cents: number }
  // Something is in the field and it is not an amount of money this can record.
  // Never silently dropped to null: a cost the shop typed and a cost the shop
  // omitted are different answers, and only one of them should overwrite a
  // stored cost. The reason is carried so the footer can say which it was --
  // "that is not money" and "that is too much money" need different sentences,
  // and a person who has fat-fingered a paste cannot act on the first one.
  | { kind: 'unreadable'; reason: 'not-an-amount' | 'too-large' };

// Every column either field lands in is a Postgres `integer`: products.cost_cents
// (0001_init.sql:34), stock_receipt_items.unit_cost_cents and .quantity
// (20260902000000_stock_receipts.sql:51 and :45). So this is the largest number
// the database can hold from this sheet. Past it the RPC fails on the server
// with a raw "integer out of range", which reaches the shop as a Postgres error
// string on a screen that was otherwise explaining itself in sentences.
const PG_INTEGER_MAX = 2_147_483_647;

// Which separators mean what, decided from the finished string:
//
//  * A dot and a comma both present: the LAST of the two is the decimal point
//    and the other is grouping. "1,234.56" and "1.234,56" are the same money.
//    Repeats of the grouping character are accepted on this path -- that is
//    what makes "1.234.567,89" read as 123456789c -- and so, as a side effect,
//    is a mixed mess like "12,3.4.5" (123450c). The leniency is load-bearing
//    for the first and merely tolerated for the second: once both characters
//    are present the last one settles the question, and refusing repeats would
//    refuse dot-grouped money along with the mess.
//  * A comma alone is a decimal point when one or two digits follow the LAST
//    comma, and thousands grouping otherwise -- however many commas there are.
//    "1,50" is one-fifty, which is what an iOS decimal-pad renders on a
//    comma-locale phone. "1,500", "10,000" and "1,234,567" all end in a group
//    of three, so the commas drop out. "1,500,00" -- what a shop that groups
//    out of habit types for fifteen hundred and no cents -- ends in a group of
//    two, so its last comma is the decimal point and it reads $1,500.00.
//    The signal is the size of the FINAL group; the number of commas is not,
//    and a rule that disqualified the last comma as soon as a second one
//    appeared read "1,500,00" as fifteen million with nothing on screen to say
//    so.
//  * A dot alone is ALWAYS the decimal point, whatever follows it. This is
//    deliberately NOT the mirror of the comma rule: "1.500" is $1.50, not
//    fifteen hundred, so a dot-grouping shop typing fifteen hundred that way
//    gets a hundredth of it. That is the accepted cost of the asymmetry -- a
//    dot from a comma-locale decimal-pad is unavailable (the key is a comma),
//    so a lone dot comes from a keyboard whose dot IS the decimal point, and
//    "1.500" from that keyboard means one-fifty with trailing zeros far more
//    often than it means grouping.
//  * More than one dot with NO comma anywhere ("12.3.4.5") is the one shape
//    with no reading at all: unreadable, which stops the commit and says so,
//    rather than recording a wrong cost that nothing downstream can spot.
//
// The two comma readings are told apart by the shape of the digit groups, which
// only exists once typing has stopped. Mid-typing, "1," and "1,5" do read as
// $1.00 and $1.50 in the footer on the way to "1,500" -- but that is the
// displayed total moving over text that was never touched, so the next
// keystroke lands on exactly what the person typed.
export function readTypedCost(text: string): TypedCost {
  if (text.trim() === '') return { kind: 'blank' };

  // A minus sign is refused, not filtered away. Stripping it turns "-4.50" --
  // a credit note typed into a cost box -- into a positive 450c, which then
  // overwrites products.cost_cents with the opposite of what was meant. The
  // column will not hold a negative anyway (cost_cents >= 0), so there is no
  // reading to give; saying so is the honest answer. The unicode minus is
  // included because a phone keyboard and a paste from a spreadsheet both
  // produce it.
  //
  // Note the divergence: restock-import.ts's parseDollarsToCents keeps '-' in
  // its filter, so the same "-4.50" in a spreadsheet cell still lands as -450c
  // on the sheet path. Recorded for Task 5 rather than changed from here.
  if (/[-−]/.test(text)) return { kind: 'unreadable', reason: 'not-an-amount' };

  // Everything else goes -- "$4.80", a space, a stray letter on web where there
  // is no decimal-pad to constrain the keyboard. A character filter is safe
  // here in a way it is not in onChangeText, because this output is never fed
  // back into the field.
  const stripped = text.replace(/[^0-9.,]/g, '');
  const lastDot = stripped.lastIndexOf('.');
  const lastComma = stripped.lastIndexOf(',');

  let decimalAt: number;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastComma !== -1) {
    // The final group decides, not the comma count: "1,500,00" ends in two
    // digits and is $1,500.00, while "1,234,567" ends in three and is grouping.
    decimalAt = /^[0-9]{1,2}$/.test(stripped.slice(lastComma + 1)) ? lastComma : -1;
  } else if (lastDot !== -1) {
    if (stripped.indexOf('.') !== lastDot) return { kind: 'unreadable', reason: 'not-an-amount' };
    decimalAt = lastDot;
  } else {
    decimalAt = -1;
  }

  // decimalAt is the last separator in the string whenever it is set, so the
  // fraction is always bare digits; only the whole part can still carry
  // grouping, and grouping is dropped.
  const whole = (decimalAt === -1 ? stripped : stripped.slice(0, decimalAt)).replace(/[.,]/g, '');
  const fraction = decimalAt === -1 ? '' : stripped.slice(decimalAt + 1);
  if (whole === '' && fraction === '') return { kind: 'unreadable', reason: 'not-an-amount' };

  const cents = Math.round(Number(`${whole || '0'}.${fraction || '0'}`) * 100);
  // Number.isFinite alone does not catch this: it takes about 309 digits to
  // reach Infinity, and everything below that is a perfectly finite number the
  // column cannot store. A pasted "999999999999,99" is 99,999,999,999,999 cents
  // and used to travel all the way to the RPC before failing.
  if (!Number.isFinite(cents) || cents > PG_INTEGER_MAX) return { kind: 'unreadable', reason: 'too-large' };
  return { kind: 'cents', cents };
}

// null means "not a quantity that can be received" -- empty, zero, not a whole
// number, or more units than the column can hold. The caller blocks the commit
// and says so on screen; it does NOT delete the row, because the row carries a
// typed unit cost that would go with it, and clearing a field to retype it is
// an ordinary edit.
//
// The ceiling is the same Postgres `integer` one the cost has
// (stock_receipt_items.quantity, 20260902000000_stock_receipts.sql:45): a
// mis-pasted quantity is the same silent trip to a raw server error as a
// mis-pasted cost, and there is no reason for one to be guarded and the other
// not.
export function readTypedQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const quantity = Number(trimmed);
  return Number.isSafeInteger(quantity) && quantity > 0 && quantity <= PG_INTEGER_MAX ? quantity : null;
}
