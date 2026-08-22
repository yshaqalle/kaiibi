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
  // Something is in the field and it is not an amount of money. Never silently
  // dropped to null: a cost the shop typed and a cost the shop omitted are
  // different answers, and only one of them should overwrite a stored cost.
  | { kind: 'unreadable' };

// Which separators mean what, decided from the finished string:
//
//  * A dot and a comma both present: the LAST of the two is the decimal point
//    and the other is grouping. "1,234.56" and "1.234,56" are the same money.
//  * A comma alone is a decimal point only when it is the only comma and
//    exactly one or two digits follow it. "1,50" is one-fifty -- not a typo but
//    what an iOS decimal-pad renders on a comma-locale phone. Three or more
//    digits after it ("1,500"), or a second comma ("1,234,567"), is a thousands
//    grouping, and the commas drop out.
//  * A dot alone is a decimal point. More than one dot with no comma ("12.3.4.5")
//    is not something to guess at: unreadable, which stops the commit and says
//    so, rather than recording a wrong cost that nothing downstream can spot.
//
// The two comma readings are told apart by the shape of the digit groups, which
// only exists once typing has stopped. Mid-typing, "1," and "1,5" do read as
// $1.00 and $1.50 in the footer on the way to "1,500" -- but that is the
// displayed total moving over text that was never touched, so the next
// keystroke lands on exactly what the person typed.
export function readTypedCost(text: string): TypedCost {
  if (text.trim() === '') return { kind: 'blank' };

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
    const onlyComma = stripped.indexOf(',') === lastComma;
    decimalAt = onlyComma && /^[0-9]{1,2}$/.test(stripped.slice(lastComma + 1)) ? lastComma : -1;
  } else if (lastDot !== -1) {
    if (stripped.indexOf('.') !== lastDot) return { kind: 'unreadable' };
    decimalAt = lastDot;
  } else {
    decimalAt = -1;
  }

  // decimalAt is the last separator in the string whenever it is set, so the
  // fraction is always bare digits; only the whole part can still carry
  // grouping, and grouping is dropped.
  const whole = (decimalAt === -1 ? stripped : stripped.slice(0, decimalAt)).replace(/[.,]/g, '');
  const fraction = decimalAt === -1 ? '' : stripped.slice(decimalAt + 1);
  if (whole === '' && fraction === '') return { kind: 'unreadable' };

  const cents = Math.round(Number(`${whole || '0'}.${fraction || '0'}`) * 100);
  return Number.isFinite(cents) ? { kind: 'cents', cents } : { kind: 'unreadable' };
}

// null means "not a quantity that can be received" -- empty, zero, or not a
// whole number. The caller blocks the commit and says so on screen; it does NOT
// delete the row, because the row carries a typed unit cost that would go with
// it, and clearing a field to retype it is an ordinary edit.
export function readTypedQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const quantity = Number(trimmed);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}
