import { readCountedQuantity, readTypedCost, readTypedQuantity } from '@/lib/restock-typed-input';

// This module is pure and only ever sees a finished string, so that is how it
// is tested here -- an earlier version of this file passed each case through a
// `type()` helper that appended one character at a time to its own output,
// which is the identity function wearing a costume. It proved nothing, and it
// read as if it proved the thing that actually matters.
//
// What it cannot prove is the half that has now shipped a wrong cost twice:
// both regressions lived in the COMPONENT's setters, where a normalising
// .replace() rewrote the text between keystrokes. Nothing in this file would
// have gone red for either of them. That half is held down by
// src/components/__tests__/stock-restock-modal.test.tsx, which types into the
// real TextInput one character at a time and asserts what the field holds after
// each one. Keep the two in step: a separator case added here belongs there too
// whenever its intermediate states are what a person would see.
// The reading as one comparable value: the number, or "unreadable:<reason>" --
// so a case that stops being readable for the wrong reason cannot pass.
const cents = (text: string): number | string => {
  const reading = readTypedCost(text);
  if (reading.kind === 'cents') return reading.cents;
  if (reading.kind === 'unreadable') return `unreadable:${reading.reason}`;
  return reading.kind;
};

describe('readTypedCost', () => {
  it('reads a comma with one or two digits after it as a decimal point', () => {
    // What an iOS decimal-pad renders on a comma-locale phone.
    expect(cents('1,50')).toBe(150);
    expect(cents('1,5')).toBe(150);
    expect(cents(',50')).toBe(50);
  });

  it('reads a comma with three digits after it as a thousands grouping', () => {
    // The regression this module was written for: typing toward 1,500 used to
    // land on $1.50, because the comma became a dot the instant it was typed
    // and the digits that would have settled the reading arrived too late.
    expect(cents('1,500')).toBe(150000);
    expect(cents('10,000')).toBe(1000000);
    expect(cents('1,234,567')).toBe(123456700);
  });

  it('lets the FINAL group decide, not the number of commas', () => {
    // "1,500,00" is what a shop that groups out of habit types for fifteen
    // hundred and no cents. Disqualifying the last comma merely because a
    // second one existed read it as fifteen million -- a 100x error with
    // nothing on screen to show for it, on the field that overwrites
    // products.cost_cents.
    expect(cents('1,500,00')).toBe(150000);
    expect(cents('1,500,0')).toBe(150000);
    expect(cents('1,500,')).toBe(150000);
    // And the grouped readings that were already right stay right.
    expect(cents('1,234,567')).toBe(123456700);
    expect(cents('12,345,678')).toBe(1234567800);
  });

  it('does not change what is in the field while a thousands number is being typed', () => {
    // The intermediate READINGS move, which is a footer total changing under a
    // half-typed number. The text does not, which is the part that matters --
    // and that part is asserted in the component test.
    expect(readTypedCost('1,')).toEqual({ kind: 'cents', cents: 100 });
    expect(readTypedCost('1,5')).toEqual({ kind: 'cents', cents: 150 });
    expect(readTypedCost('1,50')).toEqual({ kind: 'cents', cents: 150 });
    expect(readTypedCost('1,500')).toEqual({ kind: 'cents', cents: 150000 });
    expect(readTypedCost('1,500,')).toEqual({ kind: 'cents', cents: 150000 });
    expect(readTypedCost('1,500,0')).toEqual({ kind: 'cents', cents: 150000 });
    expect(readTypedCost('1,500,00')).toEqual({ kind: 'cents', cents: 150000 });
  });

  it('takes the last separator as the decimal point when both appear', () => {
    expect(cents('1,234.56')).toBe(123456);
    expect(cents('1.234,56')).toBe(123456);
    // Repeated grouping separators are accepted once both characters are
    // present -- this is the case that leniency exists for.
    expect(cents('1.234.567,89')).toBe(123456789);
    expect(cents('1,234,567.89')).toBe(123456789);
    // And the same leniency tolerates a mess. Documented rather than defended:
    // the last separator settles it, and refusing repeats would refuse
    // "1.234.567,89" too.
    expect(cents('12,3.4.5')).toBe(123450);
  });

  it('treats a lone dot as the decimal point however many digits follow', () => {
    // Deliberately NOT the mirror of the comma rule: a comma-locale
    // decimal-pad has no dot key, so a lone dot comes from a keyboard whose dot
    // IS the decimal point. A dot-grouping shop typing fifteen hundred as
    // "1.500" does get $1.50, and this is the test that says so out loud.
    expect(cents('1.500')).toBe(150);
    expect(cents('1.5')).toBe(150);
    expect(cents('1.50')).toBe(150);
  });

  it('refuses a minus sign rather than stripping it', () => {
    // A credit note typed into a cost box. Filtering the sign away recorded
    // "-4.50" as a positive 450c -- the opposite of what was meant, written
    // over the product's stored cost. The column will not hold a negative
    // anyway. (restock-import.ts's sheet path still keeps the '-'; the
    // divergence is recorded, not fixed from here.)
    expect(cents('-4.50')).toBe('unreadable:not-an-amount');
    expect(cents('-1')).toBe('unreadable:not-an-amount');
    expect(cents('−4,50')).toBe('unreadable:not-an-amount');
  });

  it('refuses a cost too large for the column instead of letting Postgres refuse it', () => {
    // products.cost_cents is `integer`. Number.isFinite needs ~309 digits to
    // fire, so everything between the column's ceiling and that was a finite
    // number that travelled to the RPC and came back as a raw
    // "integer out of range".
    expect(cents('999999999999,99')).toBe('unreadable:too-large');
    expect(cents('99999999999999999999')).toBe('unreadable:too-large');
    expect(cents('21474836.48')).toBe('unreadable:too-large');
    // The last cost that still fits, which must not be caught by the cap.
    expect(cents('21474836.47')).toBe(2147483647);
  });

  it('keeps every plain reading working', () => {
    expect(cents('1.50')).toBe(150);
    expect(cents('4.')).toBe(400);
    expect(cents('.5')).toBe(50);
    expect(cents('$4.80')).toBe(480);
  });

  it('accepts a genuine zero, because a free sample really does cost nothing', () => {
    expect(cents('0')).toBe(0);
  });

  it('reads an empty field as blank, which leaves the recorded cost alone', () => {
    expect(readTypedCost('')).toEqual({ kind: 'blank' });
    expect(readTypedCost('   ')).toEqual({ kind: 'blank' });
  });

  // The third silent 100x bug in this family, and the one that survived the
  // other two being fixed: the reading stripped everything outside [0-9.,]
  // FIRST and then read whatever digits were left, so any cell with a digit
  // anywhere in it produced a cost. Each of these silently overwrote
  // products.cost_cents, which is what stock at cost and gross profit are made
  // of, and nothing on any screen said it had happened.
  it('refuses a cell whose digits are wrapped in words, instead of reading the digits', () => {
    expect(cents('2 for 5.00')).toBe('unreadable:not-an-amount'); // was $25.00
    expect(cents('2 cases')).toBe('unreadable:not-an-amount'); // was $2.00
    expect(cents('12 x 4.80')).toBe('unreadable:not-an-amount'); // was $124.80
    expect(cents('TBD 2026')).toBe('unreadable:not-an-amount'); // was $2,026.00
    expect(cents('4.80 each')).toBe('unreadable:not-an-amount');
  });

  // The over-correction that would be just as bad, stated as its own case: a
  // letter is the discriminator, and a currency symbol or a space is not one.
  it('still reads everything a real amount is actually written with', () => {
    expect(cents('1,200.50')).toBe(120050);
    expect(cents('$4.80')).toBe(480);
    expect(cents('£1,200.50')).toBe(120050);
    expect(cents('€ 4,80')).toBe(480);
    expect(cents('4.80 ')).toBe(480);
    // Space as the thousands separator, which is what a French-locale
    // spreadsheet writes -- as an ordinary space or as a non-breaking one.
    expect(cents('1 200,50')).toBe(120050);
    expect(cents('1 200,50')).toBe(120050);
    expect(cents('1.234.567,89')).toBe(123456789);
    expect(cents('4.')).toBe(400);
    expect(cents('.5')).toBe(50);
    expect(cents('0')).toBe(0);
  });

  it('refuses to guess at something that is not an amount', () => {
    // Blocked, not dropped to null: null means "the delivery did not say", and
    // this delivery did say -- it said something unreadable.
    expect(cents('.')).toBe('unreadable:not-an-amount');
    expect(cents('12.3.4.5')).toBe('unreadable:not-an-amount');
    expect(cents('abc')).toBe('unreadable:not-an-amount');
  });
});

describe('readTypedQuantity', () => {
  it('reads a typed whole number', () => {
    expect(readTypedQuantity('24')).toBe(24);
    expect(readTypedQuantity('07')).toBe(7);
  });

  it('survives a backspace to empty and a retype, with the row still there', () => {
    // The seeded "1" of a freshly added line, cleared and typed again. Empty
    // reads as "no quantity yet" -- it does not read as zero, and nothing above
    // is allowed to take the row away over it.
    expect(readTypedQuantity('1')).toBe(1);
    expect(readTypedQuantity('')).toBeNull();
    expect(readTypedQuantity('2')).toBe(2);
    expect(readTypedQuantity('24')).toBe(24);
  });

  it('blocks on nothing, on zero and on anything that is not a whole count', () => {
    expect(readTypedQuantity('')).toBeNull();
    expect(readTypedQuantity('0')).toBeNull();
    expect(readTypedQuantity('1.5')).toBeNull();
    expect(readTypedQuantity('2a')).toBeNull();
    expect(readTypedQuantity('-3')).toBeNull();
  });

  it('blocks a quantity the column cannot hold', () => {
    // Same Postgres `integer` ceiling as the cost, for the same reason: a
    // mis-pasted number should stop here rather than at the server.
    expect(readTypedQuantity('2147483647')).toBe(2147483647);
    expect(readTypedQuantity('2147483648')).toBeNull();
    expect(readTypedQuantity('999999999999')).toBeNull();
  });
});

// Zero is the one difference between the two readers, and it is not a detail.
//
// readTypedQuantity refuses 0 because a delivery of nothing is a mistake in a
// sheet, not a no-op. A COUNT of zero is the opposite: an empty shelf is one of
// the most important findings a stock-take makes, and refusing it would mean
// the door could record every loss except a total one.
//
// Everything else -- the digits-only rule, the Postgres integer ceiling, the
// refusal of a minus sign -- is shared, deliberately, so the two entry routes
// cannot drift the way the cost readers did.
describe('readCountedQuantity', () => {
  it('accepts an empty shelf where readTypedQuantity will not', () => {
    expect(readCountedQuantity('0')).toBe(0);
    expect(readTypedQuantity('0')).toBeNull();
  });

  it('reads an ordinary count', () => {
    expect(readCountedQuantity('8')).toBe(8);
    expect(readCountedQuantity(' 26 ')).toBe(26);
  });

  it('refuses everything readTypedQuantity refuses, for the same reasons', () => {
    expect(readCountedQuantity('')).toBeNull();
    expect(readCountedQuantity('   ')).toBeNull();
    expect(readCountedQuantity('-3')).toBeNull();
    expect(readCountedQuantity('2a')).toBeNull();
    expect(readCountedQuantity('2.5')).toBeNull();
    expect(readCountedQuantity('1e3')).toBeNull();
  });

  // stock_count_items.counted_quantity is a Postgres `integer`. A pasted cell
  // past it has to be caught here, while nothing has been written, rather than
  // inside the RPC halfway through a commit.
  it('refuses more units than the column can hold', () => {
    expect(readCountedQuantity('2147483647')).toBe(2147483647);
    expect(readCountedQuantity('2147483648')).toBeNull();
  });
});
