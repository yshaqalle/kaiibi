import { DEFAULT_WEDGE_CONFIG, initialWedgeState, stepWedge, type WedgeState } from '@/lib/barcode-wedge';

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
