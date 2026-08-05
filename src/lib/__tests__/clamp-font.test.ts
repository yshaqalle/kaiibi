import { clampFont, FONT_SCALE } from '@/lib/clamp-font';

describe('clampFont', () => {
  it('holds the floor on a narrow viewport', () => {
    // 320 * 0.05 = 16, well under the 34px minimum.
    expect(clampFont(34, 0.05, 54, 320)).toBe(34);
  });

  it('holds the ceiling on a wide one', () => {
    // 1920 * 0.05 = 96, well over the 54px maximum.
    expect(clampFont(34, 0.05, 54, 1920)).toBe(54);
  });

  it('scales with width in between', () => {
    expect(clampFont(34, 0.05, 54, 880)).toBe(44);
  });

  it('returns the boundary exactly at the crossover widths', () => {
    expect(clampFont(34, 0.05, 54, 680)).toBe(34);
    expect(clampFont(34, 0.05, 54, 1080)).toBe(54);
  });

  it('survives a zero width without going negative', () => {
    // Some layout passes report 0 before measuring.
    expect(clampFont(34, 0.05, 54, 0)).toBe(34);
  });
});

describe('FONT_SCALE', () => {
  it('matches the design’s three clamped sizes', () => {
    expect(FONT_SCALE.h1(1440)).toBe(54);
    expect(FONT_SCALE.h2(1440)).toBe(38);
    expect(FONT_SCALE.stat(1440)).toBe(42);

    expect(FONT_SCALE.h1(390)).toBe(34);
    expect(FONT_SCALE.h2(390)).toBe(27);
    expect(FONT_SCALE.stat(390)).toBe(28);
  });
});
