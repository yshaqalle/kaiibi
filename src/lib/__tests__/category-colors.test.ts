import { categoryColor, categoryColors, RESIDUAL_COLOR } from '@/lib/category-colors';
import { Colors } from '@/constants/theme';

const SERIES = [
  Colors.light.chartSeries1,
  Colors.light.chartSeries2,
  Colors.light.chartSeries3,
  Colors.light.chartSeries4,
];

describe('categoryColor', () => {
  it('gives a category the same colour every time', () => {
    // The whole point: Pantry is the same blue in the donut, the stacked
    // months and any breakdown row.
    expect(categoryColor('Pantry')).toBe(categoryColor('Pantry'));
  });

  it('ignores case and surrounding space', () => {
    expect(categoryColor('Cold Brew')).toBe(categoryColor('  cold brew '));
  });

  it('reserves grey for the residual, never a real category', () => {
    expect(categoryColor('Other')).toBe(RESIDUAL_COLOR);
    expect(categoryColor('uncategorised')).toBe(RESIDUAL_COLOR);
    expect(categoryColor('Uncategorized')).toBe(RESIDUAL_COLOR);
    expect(categoryColor(null)).toBe(RESIDUAL_COLOR);
    expect(categoryColor('')).toBe(RESIDUAL_COLOR);

    expect(categoryColor('Dairy')).not.toBe(RESIDUAL_COLOR);
  });

  it('only ever returns a chart series hue for a real category', () => {
    for (const name of ['Pantry', 'Drinks', 'Dairy', 'Grains', 'Bakery', 'Household']) {
      expect(SERIES).toContain(categoryColor(name));
    }
  });

  it('never returns a semantic colour', () => {
    // A green slice must not read as good news.
    const semantic = [Colors.light.success, Colors.light.warning, Colors.light.danger, Colors.light.accent];
    for (const name of ['Pantry', 'Drinks', 'Dairy', 'Grains', 'Other']) {
      expect(semantic).not.toContain(categoryColor(name));
    }
  });
});

describe('categoryColors', () => {
  it('gives four categories four distinct colours', () => {
    const map = categoryColors(['Pantry', 'Drinks', 'Dairy', 'Grains']);
    expect(new Set(map.values()).size).toBe(4);
  });

  it('resolves a hash collision rather than repeating a hue', () => {
    // Four slots, four names: whatever they hash to, the resolver has to hand
    // out four different hues or the chart is unreadable.
    const names = ['a', 'b', 'c', 'd'];
    const map = categoryColors(names);
    expect(new Set(map.values()).size).toBe(4);
  });

  it('lets the residual repeat, since it is not a category', () => {
    const map = categoryColors(['Pantry', 'Other', 'Uncategorised']);
    expect(map.get('Other')).toBe(RESIDUAL_COLOR);
    expect(map.get('Uncategorised')).toBe(RESIDUAL_COLOR);
    expect(map.get('Pantry')).not.toBe(RESIDUAL_COLOR);
  });

  it('covers every category it is given', () => {
    const names = ['Pantry', 'Drinks', 'Dairy', 'Grains', 'Bakery', 'Household'];
    const map = categoryColors(names);
    expect([...map.keys()]).toEqual(names);
  });

  it('keeps a category’s preferred hue when nothing contests it', () => {
    expect(categoryColors(['Dairy']).get('Dairy')).toBe(categoryColor('Dairy'));
  });
});
