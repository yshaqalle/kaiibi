import { readTypedCost, readTypedQuantity } from '@/lib/restock-typed-input';

// Every case is driven over the REAL keystroke chain, not fed in as one
// finished string. A controlled TextInput hands its own value back as the base
// for the next keystroke, so a test that only ever passes the whole string
// cannot see the bug this module exists to prevent -- both times a wrong cost
// shipped from the restock sheet, the finished string was right and it was the
// half-typed one that got rewritten underneath the person typing it.
function type(typed: string, from = ''): string {
  let state = from;
  for (const character of typed) {
    // The component's setters, exactly: whatever the input hands over IS the
    // new state.
    state = state + character;
  }
  return state;
}

function centsAfterTyping(typed: string): number | string {
  const reading = readTypedCost(type(typed));
  return reading.kind === 'cents' ? reading.cents : reading.kind;
}

describe('readTypedCost', () => {
  it('reads a comma with one or two digits after it as a decimal point', () => {
    // What an iOS decimal-pad renders on a comma-locale phone.
    expect(centsAfterTyping('1,50')).toBe(150);
    expect(centsAfterTyping('1,5')).toBe(150);
    expect(centsAfterTyping(',50')).toBe(50);
  });

  it('reads a comma with three digits after it as a thousands grouping', () => {
    // The regression this module was written for: typing toward 1,500 used to
    // land on $1.50, because the comma became a dot the instant it was typed
    // and the digits that would have settled the reading arrived too late.
    expect(centsAfterTyping('1,500')).toBe(150000);
    expect(centsAfterTyping('10,000')).toBe(1000000);
    expect(centsAfterTyping('1,234,567')).toBe(123456700);
  });

  it('does not change what is in the field while a thousands number is being typed', () => {
    // The intermediate READINGS move, which is a footer total changing under a
    // half-typed number. The text does not, which is the part that matters.
    expect(type('1,500')).toBe('1,500');
    expect(readTypedCost('1,')).toEqual({ kind: 'cents', cents: 100 });
    expect(readTypedCost('1,5')).toEqual({ kind: 'cents', cents: 150 });
    expect(readTypedCost('1,50')).toEqual({ kind: 'cents', cents: 150 });
    expect(readTypedCost('1,500')).toEqual({ kind: 'cents', cents: 150000 });
  });

  it('takes the last separator as the decimal point when both appear', () => {
    expect(centsAfterTyping('1,234.56')).toBe(123456);
    expect(centsAfterTyping('1.234,56')).toBe(123456);
  });

  it('keeps every plain reading working', () => {
    expect(centsAfterTyping('1.50')).toBe(150);
    expect(centsAfterTyping('4.')).toBe(400);
    expect(centsAfterTyping('.5')).toBe(50);
    expect(centsAfterTyping('$4.80')).toBe(480);
  });

  it('accepts a genuine zero, because a free sample really does cost nothing', () => {
    expect(centsAfterTyping('0')).toBe(0);
  });

  it('reads an empty field as blank, which leaves the recorded cost alone', () => {
    expect(readTypedCost('')).toEqual({ kind: 'blank' });
    expect(readTypedCost('   ')).toEqual({ kind: 'blank' });
  });

  it('refuses to guess at something that is not an amount', () => {
    // Blocked, not dropped to null: null means "the delivery did not say", and
    // this delivery did say -- it said something unreadable.
    expect(centsAfterTyping('.')).toBe('unreadable');
    expect(centsAfterTyping('12.3.4.5')).toBe('unreadable');
    expect(centsAfterTyping('abc')).toBe('unreadable');
  });
});

describe('readTypedQuantity', () => {
  it('reads a typed whole number', () => {
    expect(readTypedQuantity(type('24'))).toBe(24);
    expect(readTypedQuantity(type('07'))).toBe(7);
  });

  it('survives a backspace to empty and a retype, with the row still there', () => {
    // The seeded "1" of a freshly added line, cleared and typed again. Empty
    // reads as "no quantity yet" -- it does not read as zero, and nothing above
    // is allowed to take the row away over it.
    let state = '1';
    expect(readTypedQuantity(state)).toBe(1);
    state = '';
    expect(readTypedQuantity(state)).toBeNull();
    state = type('24', state);
    expect(state).toBe('24');
    expect(readTypedQuantity(state)).toBe(24);
  });

  it('blocks on nothing, on zero and on anything that is not a whole count', () => {
    expect(readTypedQuantity('')).toBeNull();
    expect(readTypedQuantity('0')).toBeNull();
    expect(readTypedQuantity('1.5')).toBeNull();
    expect(readTypedQuantity('2a')).toBeNull();
    expect(readTypedQuantity('-3')).toBeNull();
  });
});
