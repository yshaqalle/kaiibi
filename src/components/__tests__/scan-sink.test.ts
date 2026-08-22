// A scan that lands in a quantity box must not become the quantity.
//
// The global document listener deliberately stands aside when focus is inside a
// field (use-barcode-wedge.ts:142) so the field can handle its own scan. Inside
// the Restock sheet that is not a nicety: every character of a barcode is a
// digit, so the failure is silent -- a quantity of 8809611860018 looks exactly
// like a number somebody typed.

import {
  DEFAULT_WEDGE_CONFIG,
  fieldBurstScan,
  fieldSinkScan,
  initialFieldBurstState,
  initialFieldSinkState,
  stepFieldBurst,
  stepFieldSink,
} from '@/lib/barcode-wedge';

// A scanner's speed: every character inside maxInterKeyMs of the last.
function scanned(text: string, startAt = 1_000) {
  let state = initialFieldBurstState();
  let before = '';
  text.split('').forEach((char, i) => {
    const next = before + char;
    state = stepFieldBurst(state, before, next, startAt + i * 5);
    before = next;
  });
  return { state, at: startAt + text.length * 5, text: before };
}

// A person's speed: well outside maxInterKeyMs.
function typed(text: string, startAt = 1_000) {
  let state = initialFieldBurstState();
  let before = '';
  text.split('').forEach((char, i) => {
    const next = before + char;
    state = stepFieldBurst(state, before, next, startAt + i * 200);
    before = next;
  });
  return { state, at: startAt + text.length * 200, text: before };
}

describe('a quantity field as a scan sink', () => {
  it('recognises a barcode arriving at scanner speed', () => {
    const { state, at } = scanned('8809611860018');
    expect(fieldBurstScan(state, at, DEFAULT_WEDGE_CONFIG)).toBe('8809611860018');
  });

  // The whole point of the guard: a real quantity must survive it untouched.
  it('leaves a hand-typed quantity alone', () => {
    const { state, at } = typed('24');
    expect(fieldBurstScan(state, at, DEFAULT_WEDGE_CONFIG)).toBeNull();
  });

  it('leaves a hand-typed number alone even when it is barcode-length', () => {
    const { state, at } = typed('8809611860018');
    expect(fieldBurstScan(state, at, DEFAULT_WEDGE_CONFIG)).toBeNull();
  });
});

// The machine the boxes actually run: the burst above, plus the one extra thing
// a Received box needs that the search box does not -- what to put BACK.
//
// Driven the way a controlled TextInput drives it: read the value the field is
// showing, hand the whole new value to the step, repeat.
function intoField(
  held: string,
  code: string,
  { msPerChar = 5, replacingSelection = false, startAt = 1_000 } = {}
) {
  let state = initialFieldSinkState(held);
  let shown = held;
  code.split('').forEach((char, i) => {
    // A field with selectTextOnFocus hands the first character a selected
    // value to replace, so the field shows that character alone.
    const next = replacingSelection && i === 0 ? char : shown + char;
    state = stepFieldSink(state, shown, next, startAt + i * msPerChar);
    shown = next;
  });
  return { state, at: startAt + code.length * msPerChar, shown };
}

describe('giving a Received box back what a person typed', () => {
  it('reports the code and the number the box was showing before it', () => {
    const { state, at } = intoField('24', '8809611860018');
    expect(fieldSinkScan(state, at)).toEqual({ code: '8809611860018', restore: '24' });
  });

  it('gives back an empty box as empty', () => {
    const { state, at } = intoField('', '8809611860018');
    expect(fieldSinkScan(state, at)).toEqual({ code: '8809611860018', restore: '' });
  });

  // Both number boxes carry selectTextOnFocus, so the scanner's first character
  // arrives as a REPLACEMENT rather than an append. Without this case the first
  // digit is lost twice over: the code goes to lookup one digit short, and the
  // box is left holding that digit as its quantity.
  it('survives the scanner replacing a selected value', () => {
    const { state, at } = intoField('1', '8809611860018', { replacingSelection: true });
    expect(fieldSinkScan(state, at)).toEqual({ code: '8809611860018', restore: '1' });
  });

  it('leaves a hand-typed 24 alone', () => {
    const { state, at } = intoField('', '24', { msPerChar: 200 });
    expect(fieldSinkScan(state, at)).toBeNull();
  });

  // Holding backspace shortens the field fast, and every one of those changes
  // is a value the field never had before. Read as a burst they would reach
  // barcode length, and an Enter after them would "restore" a number nobody
  // asked for.
  it('is not fooled by a number being deleted quickly', () => {
    let state = initialFieldSinkState('8809611860018');
    let shown = '8809611860018';
    for (let i = 0; i < 13; i += 1) {
      const next = shown.slice(0, -1);
      state = stepFieldSink(state, shown, next, 1_000 + i * 5);
      shown = next;
    }
    expect(fieldSinkScan(state, 1_070)).toBeNull();
  });

  // A terminator that arrives long after the characters belongs to nothing --
  // the same rule fieldBurstScan already holds, kept true through the wrapper.
  it('does not treat a much later Enter as the end of a burst', () => {
    const { state, at } = intoField('24', '8809611860018');
    expect(fieldSinkScan(state, at + DEFAULT_WEDGE_CONFIG.maxTerminatorGapMs + 1)).toBeNull();
  });
});
