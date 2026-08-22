import { fieldBurstScan, initialFieldBurstState, stepFieldBurst, type FieldBurstState } from '@/lib/barcode-wedge';

// Types `code` into a field that already holds `existing`, one character at a
// time with a fixed gap -- what a wedge scanner does to a search box the
// cashier has clicked into. Reports what the field ends up holding and what the
// terminator resolves to.
function scanInto(existing: string, code: string, gapMs: number, terminatorGapMs = gapMs) {
  let state: FieldBurstState = initialFieldBurstState();
  let value = existing;
  let at = 1000;

  for (const char of code) {
    const next = value + char;
    state = stepFieldBurst(state, value, next, at);
    value = next;
    at += gapMs;
  }

  at += terminatorGapMs - gapMs;
  return { scan: fieldBurstScan(state, at), value };
}

describe('stepFieldBurst', () => {
  // The bug this exists for: the second scan into a box still showing the first
  // read as 88094472559728809447255972 -- one code that matches nothing,
  // growing by thirteen digits per scan.
  it('reads only the newest code out of a field still holding the last one', () => {
    const { scan, value } = scanInto('8809447255972', '8809447255972', 5);
    expect(value).toBe('88094472559728809447255972');
    expect(scan).toBe('8809447255972');
  });

  it('reads a code scanned into an empty field', () => {
    expect(scanInto('', '5012345678900', 5).scan).toBe('5012345678900');
  });

  // The same discriminator as everywhere else in this file: a person cannot
  // type fast enough to be mistaken for a scanner, so their Enter must leave
  // whatever they typed alone.
  it('reads nothing out of the same digits typed at human speed', () => {
    expect(scanInto('', '5012345678900', 150).scan).toBeNull();
  });

  it('leaves a typed search term alone when Enter follows it', () => {
    expect(scanInto('', 'shea butter', 150).scan).toBeNull();
  });

  // A whole string arriving in ONE change is a paste, and it is never a scan.
  //
  // This case used to assert the opposite, on the belief that native delivers a
  // whole code in a single `onChangeText`. It does not: `onChangeText` always
  // reports the whole FIELD, on both platforms, which is why this machine is
  // given `before` and `next` and measures the delta -- and a hardware scanner
  // is a keyboard, so its delta is one character at a time. The only thing that
  // really arrives whole is a paste, and treating it as a scan is how `1500`
  // pasted into a Received box became a barcode: the field handed the digits to
  // the basket and silently put itself back to `1`. (The native invisible sink
  // does read whole payloads -- that is `stepSink`, a different machine.)
  it('reads nothing from a whole string arriving in one change, which is a paste', () => {
    let state = initialFieldBurstState();
    state = stepFieldBurst(state, '', 'shea', 1000);
    state = stepFieldBurst(state, 'shea', 'shea8809447255972', 4000);
    expect(fieldBurstScan(state, 4000)).toBeNull();
  });

  // And the same paste straight into an empty field, which is the shape the
  // Restock sheet actually sees: a quantity copied off an invoice.
  it('reads nothing from a pasted number, so the paste survives', () => {
    let state = initialFieldBurstState();
    state = stepFieldBurst(state, '', '1500', 1000);
    expect(fieldBurstScan(state, 1000)).toBeNull();
    expect(state.burst).toBe('');
  });

  // The reported bug, and the reason the terminator gets a window of its own.
  // The characters are the discriminator -- nobody types thirteen digits at
  // five milliseconds apart -- but the Enter that ends them is not delivered on
  // the same clock: a scanner can be configured with a suffix delay, and on
  // Android the submit crosses a render pass the characters did not. Judging it
  // by the inter-CHARACTER gap made a scan a fifth of a second late read as
  // typing, so the field kept the old code and the new one landed on the end of
  // it -- 8094472559728809447255972, matching nothing, exactly the bug the
  // burst rules exist to prevent.
  it('resolves a scan whose Enter lags the characters', () => {
    const { scan, value } = scanInto('8809447255972', '8809447255972', 5, 400);
    expect(value).toBe('88094472559728809447255972');
    expect(scan).toBe('8809447255972');
  });

  // The window is still a window. An Enter this long after the last character
  // is a person pressing it deliberately -- reading the box, then searching for
  // what is in it -- and their text has to survive that untouched.
  it('reads nothing when the Enter arrives long after the burst', () => {
    expect(scanInto('', '5012345678900', 5, 1500).scan).toBeNull();
  });

  it('reads nothing from a burst too short to be a real code', () => {
    expect(scanInto('', 'abc', 5).scan).toBeNull();
  });

  // Backspacing shortens the field, so nothing was appended and there is no
  // burst -- otherwise correcting a mistyped code by hand would end with the
  // field replaced by a fragment of itself.
  it('reads nothing when the field is edited down rather than extended', () => {
    let state = initialFieldBurstState();
    state = stepFieldBurst(state, '', '8809447255972', 1000);
    state = stepFieldBurst(state, '8809447255972', '880944725597', 1005);
    expect(fieldBurstScan(state, 1005)).toBeNull();
  });

  // The screen sets the search box itself after a camera scan or a wedge scan
  // that landed while nothing was focused. That is not typing and must not
  // leave a burst behind for the next Enter to act on.
  it('reads nothing when the value is replaced from outside the field', () => {
    let state = initialFieldBurstState();
    state = stepFieldBurst(state, '', '8809447255972', 1000);
    state = stepFieldBurst(state, '8809447255972', 'shea butter', 1005);
    expect(fieldBurstScan(state, 1005)).toBeNull();
  });

  // Two scans in a row, the cashier reaching for the next item in between.
  it('starts a new burst for each scan rather than joining them', () => {
    let state = initialFieldBurstState();
    let value = '';
    let at = 1000;
    const scans: (string | null)[] = [];

    for (const code of ['5012345678900', '111111111111']) {
      for (const char of code) {
        const next = value + char;
        state = stepFieldBurst(state, value, next, at);
        value = next;
        at += 5;
      }
      scans.push(fieldBurstScan(state, at));
      at += 400; // reaching for the next item
    }

    expect(scans).toEqual(['5012345678900', '111111111111']);
  });
});
