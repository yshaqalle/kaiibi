import {
  flushWedgeIfIdle, DEFAULT_WEDGE_CONFIG, initialWedgeState, stepWedge, type WedgeState } from '@/lib/barcode-wedge';

// Types `code` one character at a time with a fixed gap, then the terminator,
// and reports whatever the machine emitted.
function type(code: string, gapMs: number, terminator: string | null = 'Enter', terminatorGapMs = gapMs) {
  let state: WedgeState = initialWedgeState();
  let at = 1000;
  const emitted: string[] = [];
  let consumedTerminator = false;

  for (const char of code) {
    const step = stepWedge(state, char, at, DEFAULT_WEDGE_CONFIG);
    state = step.state;
    if (step.emit) emitted.push(step.emit);
    at += gapMs;
  }

  if (terminator !== null) {
    at += terminatorGapMs - gapMs;
    const step = stepWedge(state, terminator, at, DEFAULT_WEDGE_CONFIG);
    state = step.state;
    if (step.emit) emitted.push(step.emit);
    consumedTerminator = step.consumed;
  }

  return { emitted, consumedTerminator, state };
}

describe('stepWedge', () => {
  it('emits a full code typed at scanner speed', () => {
    const { emitted, consumedTerminator } = type('5012345678900', 5);
    expect(emitted).toEqual(['5012345678900']);
    // The Enter is swallowed so it cannot also press whatever has focus.
    expect(consumedTerminator).toBe(true);
  });

  // The whole point of the heuristic: a person cannot type fast enough to be
  // mistaken for a scanner.
  it('emits nothing for the same digits typed at human speed', () => {
    const { emitted, consumedTerminator } = type('5012345678900', 150);
    expect(emitted).toEqual([]);
    expect(consumedTerminator).toBe(false);
  });

  it('accepts Tab as a terminator', () => {
    expect(type('5012345678900', 5, 'Tab').emitted).toEqual(['5012345678900']);
  });

  it('discards the buffer when a gap interrupts the burst', () => {
    let state = initialWedgeState();
    let at = 1000;
    for (const char of '5012') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    // A long pause: whatever came before is a different burst.
    at += 900;
    for (const char of '345678900') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    const final = stepWedge(state, 'Enter', at);
    expect(final.emit).toBe('345678900');
  });

  it('does not emit a buffer shorter than minLength', () => {
    expect(type('501', 5).emitted).toEqual([]);
  });

  // Type a few characters quickly, wander off, then press Enter -- that is a
  // person, not a scan.
  it('does not emit when the terminator arrives long after the last character', () => {
    const { emitted, consumedTerminator } = type('50123', 5, 'Enter', 2000);
    expect(emitted).toEqual([]);
    expect(consumedTerminator).toBe(false);
  });

  it('ignores modifier and navigation keys without breaking the burst', () => {
    let state = initialWedgeState();
    let at = 1000;
    for (const char of '501234') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    for (const key of ['Shift', 'ArrowLeft', 'F1']) {
      const step = stepWedge(state, key, at);
      expect(step.emit).toBeNull();
      expect(step.consumed).toBe(false);
      state = step.state;
      at += 5;
    }
    for (const char of '5678900') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    expect(stepWedge(state, 'Enter', at).emit).toBe('5012345678900');
  });

  it('handles two back-to-back scans cleanly', () => {
    let state = initialWedgeState();
    let at = 1000;
    const emitted: string[] = [];

    for (const code of ['5012345678900', '111111111111']) {
      for (const char of code) {
        const step = stepWedge(state, char, at);
        state = step.state;
        at += 5;
      }
      const step = stepWedge(state, 'Enter', at);
      state = step.state;
      if (step.emit) emitted.push(step.emit);
      at += 400; // the cashier reaches for the next item
    }

    expect(emitted).toEqual(['5012345678900', '111111111111']);
  });

  it('emits an alphanumeric SKU scanned from an internal label', () => {
    expect(type('TSHIRT-BLU-M', 5).emitted).toEqual(['TSHIRT-BLU-M']);
  });
});

// A scanner with no suffix configured -- common on Bluetooth models, and fatal
// before this existed: the code sat in the buffer waiting for an Enter that was
// never coming, and the till never saw the scan at all.
describe('flushWedgeIfIdle', () => {
  function burst(code: string, gapMs: number) {
    let state = initialWedgeState();
    let at = 1000;
    for (const char of code) {
      state = stepWedge(state, char, at).state;
      at += gapMs;
    }
    return { state, at };
  }

  it('reads a code out of a burst that went quiet without a terminator', () => {
    const { state, at } = burst('8809447255972', 5);
    expect(flushWedgeIfIdle(state, at + 250)).toBe('8809447255972');
  });

  it('waits while the scanner may still be mid-code', () => {
    const { state, at } = burst('8809447255972', 5);
    expect(flushWedgeIfIdle(state, at + 50)).toBeNull();
  });

  // The speed check lives in `stepWedge`, which restarts the buffer on any
  // human-sized gap -- so typing never accumulates enough to be flushed.
  it('reads nothing out of text typed at human speed', () => {
    const { state, at } = burst('shea butter', 150);
    expect(flushWedgeIfIdle(state, at + 250)).toBeNull();
  });

  it('reads nothing out of a burst too short to be a code', () => {
    const { state, at } = burst('abc', 5);
    expect(flushWedgeIfIdle(state, at + 250)).toBeNull();
  });
});

// The bug the fragment rule exists for: a delivery that stalls mid-code splits
// the burst, and flushing the tail offers the till a suffix of the real barcode
// -- `9447255972` out of `8809447255972`, matching nothing and looking real.
describe('flushWedgeIfIdle and split bursts', () => {
  it('reads nothing out of the tail of a burst that was broken by a stall', () => {
    let state = initialWedgeState();
    let at = 1000;
    for (const char of '880') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    at += 400; // the stall
    for (const char of '9447255972') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    expect(flushWedgeIfIdle(state, at + 250)).toBeNull();
  });

  // A terminator still speaks for itself: the scanner is saying where the code
  // ends, so a fragment it ends is emitted as before.
  it('still resolves a broken burst when the scanner terminates it', () => {
    let state = initialWedgeState();
    let at = 1000;
    for (const char of '880') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    at += 400;
    for (const char of '9447255972') {
      state = stepWedge(state, char, at).state;
      at += 5;
    }
    expect(stepWedge(state, 'Enter', at).emit).toBe('9447255972');
  });
});
