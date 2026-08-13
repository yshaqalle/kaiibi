import { POSTER_SHAPES } from '@/components/marketing/poster-canvas';

describe('POSTER_SHAPES', () => {
  it('offers a square, a story and a sheet', () => {
    expect(Object.keys(POSTER_SHAPES).sort()).toEqual(['sheet', 'square', 'story']);
  });

  it('uses the real aspect ratios, so an export is not a squashed square', () => {
    expect(POSTER_SHAPES.square.ratio).toBeCloseTo(1, 5);
    expect(POSTER_SHAPES.story.ratio).toBeCloseTo(9 / 16, 5);
    expect(POSTER_SHAPES.sheet.ratio).toBeCloseTo(1 / 1.414, 3);
  });
});
