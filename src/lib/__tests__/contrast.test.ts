import { contrastRatio, inkFor, parseHex, relativeLuminance, stepUntilContrast } from '@/lib/contrast';

describe('parseHex', () => {
  it('reads a six-digit hex', () => {
    expect(parseHex('#5B31B5')).toEqual({ r: 91, g: 49, b: 181 });
  });

  it('reads a three-digit hex', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('tolerates a missing hash and mixed case', () => {
    expect(parseHex('ffD400')).toEqual({ r: 255, g: 212, b: 0 });
  });

  it('returns null for anything that is not a colour', () => {
    expect(parseHex('not a colour')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  // The two anchors of the WCAG scale.
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black against white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio('#5B31B5', '#5B31B5')).toBeCloseTo(1, 5);
  });

  it('does not care which way round the pair is given', () => {
    expect(contrastRatio('#5B31B5', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#5B31B5'), 5);
  });
});

describe('inkFor', () => {
  it('puts white type on a deep ground', () => {
    expect(inkFor('#0F2B5B')).toBe('#ffffff');
    expect(inkFor('#5B31B5')).toBe('#ffffff');
  });

  it('puts black type on a bright ground — the whole reason this exists', () => {
    expect(inkFor('#FFD400')).toBe('#141210');
    expect(inkFor('#faf8f4')).toBe('#141210');
  });

  it('always returns an ink that clears 4.5:1 on its own ground', () => {
    for (const ground of ['#FFD400', '#0F2B5B', '#5B31B5', '#12A15E', '#808080', '#ffffff', '#000000']) {
      expect(contrastRatio(inkFor(ground), ground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('stepUntilContrast', () => {
  it('leaves a colour alone when it already clears the bar', () => {
    expect(stepUntilContrast('#FFD400', '#0b0b0d', 4.5)).toBe('#FFD400');
  });

  it('lightens a colour too dark for a dark ground until it clears', () => {
    const stepped = stepUntilContrast('#0F2B5B', '#0b0b0d', 4.5);
    expect(stepped).not.toBe('#0F2B5B');
    expect(contrastRatio(stepped, '#0b0b0d')).toBeGreaterThanOrEqual(4.5);
  });

  it('darkens a colour too light for a light ground until it clears', () => {
    const stepped = stepUntilContrast('#FFD400', '#faf8f4', 4.5);
    expect(contrastRatio(stepped, '#faf8f4')).toBeGreaterThanOrEqual(4.5);
  });

  it('gives up at black or white rather than looping forever', () => {
    // 21:1 is the theoretical maximum, so nothing can clear a higher bar.
    const stepped = stepUntilContrast('#808080', '#808080', 21);
    expect(['#ffffff', '#000000']).toContain(stepped.toLowerCase());
  });

  it('returns the input unchanged when it is not a colour', () => {
    expect(stepUntilContrast('nonsense', '#000000', 4.5)).toBe('nonsense');
  });
});
