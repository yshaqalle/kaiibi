import {
  arcOpacity, arcPoint, arcScale, clearSlipTarget, countUpDuration, countUpValue, fireFlyToCart, flyToCartMotion,
  getSlipTarget, registerFlyTrigger, resetFlyToCartForTests, setSlipTarget, slipBumpMotion, unregisterFlyTrigger,
} from '@/components/storefront/fly-to-cart';

afterEach(() => {
  resetFlyToCartForTests();
});

// THE ARC. Pure geometry, so a test can hold the exact point at any
// progress without rendering anything -- the shared reanimated jest mock
// resolves every animation synchronously and discards intermediate frames,
// so this is the only way to pin the shape of the flight at all (see this
// module's own header comment).
describe('arcPoint: the dot\'s position mid-flight', () => {
  const from = { x: 20, y: 400 };
  const to = { x: 300, y: 40 };

  it('starts exactly on the tile at t=0', () => {
    expect(arcPoint(from, to, 0)).toEqual(from);
  });

  it('ends exactly on the slip at t=1', () => {
    expect(arcPoint(from, to, 1)).toEqual(to);
  });

  it('rises above the straight line between the two at the midpoint -- the arc, not a drag', () => {
    const straightLineY = (from.y + to.y) / 2;
    const mid = arcPoint(from, to, 0.5);
    expect(mid.y).toBeLessThan(straightLineY);
  });

  it('clamps progress outside [0, 1] rather than extrapolating past either end', () => {
    expect(arcPoint(from, to, -0.4)).toEqual(from);
    expect(arcPoint(from, to, 1.4)).toEqual(to);
  });
});

describe('arcScale: the dot shrinking over the flight', () => {
  it('is full-size leaving the tile', () => {
    expect(arcScale(0)).toBe(1);
  });

  it('is the mockup\'s own 0.45 landing in the slip', () => {
    expect(arcScale(1)).toBeCloseTo(0.45);
  });

  it('shrinks monotonically in between', () => {
    expect(arcScale(0.25)).toBeGreaterThan(arcScale(0.75));
  });
});

describe('arcOpacity: fading only over the back half of the flight', () => {
  it('stays fully opaque through the first 55% of the flight', () => {
    expect(arcOpacity(0)).toBe(1);
    expect(arcOpacity(0.3)).toBe(1);
    expect(arcOpacity(0.55)).toBe(1);
  });

  it('fades to the mockup\'s own 0.7 by the time it lands', () => {
    expect(arcOpacity(1)).toBeCloseTo(0.7);
  });

  it('fades monotonically over the back half', () => {
    expect(arcOpacity(0.7)).toBeGreaterThan(arcOpacity(0.9));
  });
});

// THE REDUCED-MOTION BRANCHES.
describe('flyToCartMotion: does the dot exist at all', () => {
  it('arcs under ordinary motion', () => {
    expect(flyToCartMotion(false)).toBe('arc');
  });

  it('never exists under reduced motion -- there is no "instant dot"', () => {
    expect(flyToCartMotion(true)).toBe('jump');
  });
});

describe('slipBumpMotion: how the slip still acknowledges the Add', () => {
  it('spring-scales 3.5% under ordinary motion', () => {
    expect(slipBumpMotion(false)).toEqual({ kind: 'scale', amount: 1.035 });
  });

  it('trades the scale for an opacity flash under reduced motion -- the acknowledgement survives, the movement does not', () => {
    expect(slipBumpMotion(true)).toEqual({ kind: 'opacity' });
  });
});

// THE COUNT-UP.
describe('countUpDuration', () => {
  it('is 300ms under ordinary motion, per the brief', () => {
    expect(countUpDuration(false)).toBe(300);
  });

  it('is instant under reduced motion', () => {
    expect(countUpDuration(true)).toBe(0);
  });
});

describe('countUpValue: what the slip reads mid-tween', () => {
  it('reads the starting total before any time has elapsed', () => {
    expect(countUpValue(0, 5800, 0, 300)).toBe(0);
  });

  it('reads exactly the new total once the duration has fully elapsed', () => {
    expect(countUpValue(0, 5800, 300, 300)).toBe(5800);
  });

  it('is past the halfway mark at the halfway point -- a cubic ease-out front-loads the climb', () => {
    const atHalfTime = countUpValue(0, 10000, 150, 300);
    expect(atHalfTime).toBeGreaterThan(5000);
  });

  it('jumps straight to the new total when duration is zero -- reduced motion\'s own branch', () => {
    expect(countUpValue(1000, 9000, 0, 0)).toBe(9000);
  });

  it('never overshoots the new total once elapsed exceeds the duration', () => {
    expect(countUpValue(0, 4400, 10000, 300)).toBe(4400);
  });

  it('counts down as readily as up -- a quantity decrease in the cart tweens the same way', () => {
    const mid = countUpValue(9000, 1000, 150, 300);
    expect(mid).toBeLessThan(9000);
    expect(mid).toBeGreaterThan(1000);
  });
});

// THE SLIP TARGET AND FLY-TRIGGER REGISTRIES.
describe('the slip target registry', () => {
  it('has nothing registered until CheckoutBar lays out', () => {
    expect(getSlipTarget()).toBeNull();
  });

  it('holds whatever CheckoutBar last measured', () => {
    setSlipTarget({ x: 40, y: 600 });
    expect(getSlipTarget()).toEqual({ x: 40, y: 600 });
  });
});

// THE INTERLEAVING THAT USED TO BREAK BOTH REGISTRIES: two owners briefly
// alive at once (a route transition where the outgoing ShopChrome has not
// yet unmounted when the incoming one mounts), and the FIRST one's cleanup
// running AFTER the second has already registered. An unconditional clear
// (what both registries did before this fix) wipes the second, live
// registration; an identity-checked one leaves it alone because the
// cleanup no longer owns the current claim.
describe('cleanup only clears its own registration, not whoever replaced it', () => {
  it('slip target: clearing an earlier owner after a later one has registered leaves the later one in place', () => {
    const ownerA = {};
    const ownerB = {};
    setSlipTarget({ x: 10, y: 20 }, ownerA); // A registers (mounts)
    setSlipTarget({ x: 99, y: 88 }, ownerB); // B registers (mounts) before A unmounts
    clearSlipTarget(ownerA); // A's cleanup finally runs, out of order
    expect(getSlipTarget()).toEqual({ x: 99, y: 88 });
  });

  it('fly trigger: unregistering an earlier trigger after a later one has registered leaves the later one callable', () => {
    const triggerA = jest.fn();
    const triggerB = jest.fn();
    registerFlyTrigger(triggerA); // A registers (mounts)
    registerFlyTrigger(triggerB); // B registers (mounts) before A unmounts
    unregisterFlyTrigger(triggerA); // A's cleanup finally runs, out of order
    fireFlyToCart({ x: 5, y: 5 });
    expect(triggerB).toHaveBeenCalledWith({ x: 5, y: 5 });
    expect(triggerA).not.toHaveBeenCalled();
  });
});

describe('fireFlyToCart: the trigger registry', () => {
  it('calls the registered trigger with the press origin', () => {
    const trigger = jest.fn();
    registerFlyTrigger(trigger);
    fireFlyToCart({ x: 12, y: 34 });
    expect(trigger).toHaveBeenCalledWith({ x: 12, y: 34 });
  });

  it('does nothing when no layer has registered a trigger -- a shop with no overlay mounted still gets its cart updated elsewhere', () => {
    expect(() => fireFlyToCart({ x: 1, y: 1 })).not.toThrow();
  });

  it('never calls the trigger for a null origin -- the fail-closed branch for a press with no coordinate to give', () => {
    const trigger = jest.fn();
    registerFlyTrigger(trigger);
    fireFlyToCart(null);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('never calls the trigger for a non-finite coordinate', () => {
    const trigger = jest.fn();
    registerFlyTrigger(trigger);
    fireFlyToCart({ x: NaN, y: 10 });
    expect(trigger).not.toHaveBeenCalled();
  });
});
