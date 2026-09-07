import { shouldConsumeWheel } from '@/components/storefront/mouse-pan';

// THE DEAD ZONE THIS PINS: category-band.tsx and flyer-carousel.tsx used to
// call `event.preventDefault()` on every wheel tick before ever asking
// whether the band had anywhere to pan. A band that fits its viewport
// (`maxOffset` 0 -- a handful of categories on a wide column) swallowed the
// tick into nothing: it couldn't scroll itself, and the page behind it
// wasn't allowed to either. The same trap bites a band that DOES overflow
// once the pointer reaches either end of its travel. `shouldConsumeWheel` is
// the question both handlers now ask first -- see its own comment in
// mouse-pan.ts for the exact rule.
describe('shouldConsumeWheel: whether a wheel tick should be stolen from the page', () => {
  it('never consumes when the content has no overflow at all', () => {
    expect(shouldConsumeWheel(0, 0, 40)).toBe(false);
    expect(shouldConsumeWheel(0, 0, -40)).toBe(false);
  });

  it('at the very start of travel, scrolling further back falls through to the page', () => {
    expect(shouldConsumeWheel(0, 900, -40)).toBe(false);
  });

  it('at the very end of travel, scrolling further forward falls through to the page', () => {
    expect(shouldConsumeWheel(900, 900, 40)).toBe(false);
  });

  it('mid-travel, scrolling forward is consumed -- there is room ahead', () => {
    expect(shouldConsumeWheel(450, 900, 40)).toBe(true);
  });

  it('mid-travel, scrolling back is consumed -- there is room behind', () => {
    expect(shouldConsumeWheel(450, 900, -40)).toBe(true);
  });

  it('at the start, scrolling FORWARD is still consumed -- the dead direction is the only one refused', () => {
    expect(shouldConsumeWheel(0, 900, 40)).toBe(true);
  });

  it('at the end, scrolling BACK is still consumed -- the dead direction is the only one refused', () => {
    expect(shouldConsumeWheel(900, 900, -40)).toBe(true);
  });

  it('a delta of exactly zero consumes nothing -- there is no direction to have travel in', () => {
    expect(shouldConsumeWheel(450, 900, 0)).toBe(false);
  });
});
