import { auroraMotion, withAlpha } from '@/components/storefront/aurora';

// THE ONE DECISION THE AURORA MAKES: given a photo/no-photo shop and a
// reduced-motion flag, does it loop, render static, or not render at all.
// Pulled out as its own pure function for the same reason heroRiseDelay
// (theme-shared.tsx) is -- nothing about a 14s `withRepeat` loop can be
// asserted through a render: the shared reanimated jest mock resolves
// every animation synchronously and has no notion of "still running".
describe('auroraMotion', () => {
  it('never renders over a photo, motion setting aside -- the hero scrim owns that surface', () => {
    expect(auroraMotion(true, false)).toBe('none');
    expect(auroraMotion(true, true)).toBe('none');
  });

  it('loops on a photoless shop under ordinary motion', () => {
    expect(auroraMotion(false, false)).toBe('loop');
  });

  it('is a single static wash on a photoless shop under reduced motion', () => {
    expect(auroraMotion(false, true)).toBe('static');
  });
});

// THE PALETTE-DERIVED "FAMILY". No radial gradient and no blur are
// available on this branch (expo-linear-gradient draws linear gradients
// only; expo-blur is forbidden) -- see aurora.tsx's own header comment on
// what is actually built instead. `withAlpha` is the one piece of that
// approximation that is pure arithmetic: it turns the palette's own single
// accent hex into an rgba() string at a given alpha, so three blobs can
// share one hue without ever writing a second hex literal at a call site.
describe('withAlpha', () => {
  it('keeps the palette\'s own RGB, changing only the alpha channel', () => {
    expect(withAlpha('#141418', 0.5)).toBe('rgba(20, 20, 24, 0.5)');
  });

  it('reads a three-digit hex the same way a six-digit one is read', () => {
    expect(withAlpha('#fff', 0.2)).toBe('rgba(255, 255, 255, 0.2)');
  });

  it('clamps an out-of-range alpha rather than emitting an invalid rgba()', () => {
    expect(withAlpha('#8a2c62', 4)).toBe('rgba(138, 44, 98, 1)');
    expect(withAlpha('#8a2c62', -1)).toBe('rgba(138, 44, 98, 0)');
  });

  it('fails open to the hex itself, fully opaque, on a value it cannot parse', () => {
    expect(withAlpha('not-a-colour', 0.5)).toBe('not-a-colour');
  });
});
