// THE SIGNATURE INTERACTION docs/design/storefront-bold-motion-mockup.html's
// "2 - Kinetic tiles, and the fly-to-cart" section names: Add doesn't just
// increment a number somewhere -- a dot leaves the button, arcs into the
// slip, the slip bumps, and the total counts up. This module is every part
// of that decision a test can hold without rendering anything -- the arc's
// geometry, the reduced-motion branch, and the count-up tween -- plus the
// two tiny process-wide registries that hand a coordinate from a pressed
// tile (anywhere in a scrolling grid) to the slip (a fixed overlay) without
// threading a ref through three themes and two leaf components.
//
// WHY A REGISTRY AND NOT PROPS. `onAdd` already flows from each theme down
// through ProductTile to ProductActions, and threading a second callback
// (the fly trigger) and a third (the slip's own screen position) alongside
// it would mean changing that prop's shape in three themes for a decision
// that is purely visual and has nothing to do with the cart itself. HERO_RISEN
// (this file's neighbour, theme-shared.tsx) already establishes the pattern
// this repo uses for exactly this shape of problem -- a fact one component
// produces and another, unrelated in the tree, needs to read -- and this is
// the same shape: CheckoutBar knows where the slip is; ProductActions knows
// when a press happened; neither should have to import the other to say so.

export type Point = { x: number; y: number };

// ─────────────────────────────────────────────────────────────────────────
// THE ARC. A single quadratic Bezier through a control point lifted above
// the straight line between `from` and `to`, rather than the mockup's own
// three hand-placed keyframes (0%, 55%, 100%) -- one continuous formula
// produces the same "leaves the button, rises, drops into the slip" shape
// and can be sampled at ANY progress a spring or a frame callback produces,
// not just the three points CSS keyframes fix in advance.
// ─────────────────────────────────────────────────────────────────────────

// How far above the straight line the arc's midpoint rises, in dp. Roughly
// double the mockup's own -34px keyframe offset: RN devices this page has to
// stay legible on run coarser dp-per-pixel than a desktop's CSS pixel, and a
// flatter arc read as a drag rather than a toss during on-device testing of
// an earlier storefront pass (theme-window's carousel arrows).
const ARC_LIFT = 64;

// PURE, and marked as a worklet so Reanimated's babel plugin can run it on
// the UI thread from inside useAnimatedStyle -- the whole point of driving
// the dot off a shared value rather than React state. Also perfectly
// callable as plain JS from a test: the 'worklet' directive is a no-op
// string statement outside Reanimated's own transform.
export function arcPoint(from: Point, to: Point, t: number): Point {
  'worklet';
  const k = Math.max(0, Math.min(1, t));
  const control: Point = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - ARC_LIFT };
  const u = 1 - k;
  return {
    x: u * u * from.x + 2 * u * k * control.x + k * k * to.x,
    y: u * u * from.y + 2 * u * k * control.y + k * k * to.y,
  };
}

// Shrinks 1 -> 0.45 over the flight -- the same two endpoints the mockup's
// own keyframes use (`scale(1)` at t=0, `scale(.45)` at t=1) -- so the dot
// reads as leaving a full-size button and arriving as a small commit into
// the slip.
export function arcScale(t: number): number {
  'worklet';
  const k = Math.max(0, Math.min(1, t));
  return 1 - k * 0.55;
}

// Full opacity through the rise, fading only over the back half of the
// flight (1 -> 0.7 from t=0.55 to t=1) -- the mockup's own keyframe offsets
// it there rather than fading from the very start, so the dot stays fully
// legible against the tile it just left.
export function arcOpacity(t: number): number {
  'worklet';
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.55) return 1;
  return 1 - ((k - 0.55) / 0.45) * 0.3;
}

// ─────────────────────────────────────────────────────────────────────────
// THE REDUCED-MOTION BRANCHES. Two separate decisions because the brief
// draws two separate lines: the DOT either arcs or never exists at all
// (there is no "instant dot"), while the SLIP still has to acknowledge the
// Add -- reduced motion trades its scale-bump for an opacity flash rather
// than dropping the acknowledgement entirely.
// ─────────────────────────────────────────────────────────────────────────

export function flyToCartMotion(reducedMotion: boolean): 'arc' | 'jump' {
  return reducedMotion ? 'jump' : 'arc';
}

export type BumpMotion = { kind: 'scale'; amount: number } | { kind: 'opacity' };

// 1.035 -- the brief's own "spring-bumps 3.5%" -- kept as a named amount
// rather than folded into a literal at every call site, the same reason
// TABULAR and CHECKOUT_BLUE are constants instead of inline values.
export const SLIP_BUMP_SCALE = 1.035;

export function slipBumpMotion(reducedMotion: boolean): BumpMotion {
  return reducedMotion ? { kind: 'opacity' } : { kind: 'scale', amount: SLIP_BUMP_SCALE };
}

// ─────────────────────────────────────────────────────────────────────────
// THE COUNT-UP. `countUpValue` is the mockup's own `countTo` tween
// (`1-(1-k)^3`, a cubic ease-out) expressed as a function of elapsed time
// rather than a requestAnimationFrame loop holding the only copy of the
// maths -- so a test can ask "at 90ms into a 300ms tween from $0 to $58,
// what does the slip read" without waiting 90ms or mocking a clock.
// ─────────────────────────────────────────────────────────────────────────

export function countUpDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : 300;
}

export function countUpValue(fromCents: number, toCents: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return toCents;
  const k = Math.max(0, Math.min(1, elapsedMs / durationMs));
  const eased = 1 - Math.pow(1 - k, 3);
  return Math.round(fromCents + (toCents - fromCents) * eased);
}

// ─────────────────────────────────────────────────────────────────────────
// THE SLIP TARGET. Set once by CheckoutBar (theme-shared.tsx), on every
// layout of the slip it renders -- a plain module-level value rather than a
// ref threaded up through three themes, for the reason in this file's own
// header comment. Window-space (pageX/pageY), not local to any scroll
// container: window coordinates are scroll-invariant, which is what makes
// the FlyToCartLayer's own conversion (window -> its own local space)
// correct regardless of how far the product grid has been scrolled at the
// moment a customer presses Add.
// ─────────────────────────────────────────────────────────────────────────

let slipTarget: Point | null = null;

export function setSlipTarget(point: Point | null): void {
  slipTarget = point;
}

export function getSlipTarget(): Point | null {
  return slipTarget;
}

// ─────────────────────────────────────────────────────────────────────────
// THE FLY TRIGGER. Registered by FlyToCartLayer (mounted once, inside
// ShopChrome, so every theme gets it for free) and fired by ProductActions'
// own Add press -- the origin point it hands over is the touch's own
// pageX/pageY, already in the same window space setSlipTarget above stores.
// `origin` is nullable because a press with no coordinate to give (a
// synthetic press from a keyboard or assistive tech, or a test harness that
// never populates nativeEvent.pageX/pageY) must degrade to "no dot" rather
// than fly to (0, 0) -- the same fail-closed posture isProductNew takes on a
// malformed timestamp.
// ─────────────────────────────────────────────────────────────────────────

type FlyTrigger = (origin: Point) => void;

let flyTrigger: FlyTrigger | null = null;

export function registerFlyTrigger(trigger: FlyTrigger | null): void {
  flyTrigger = trigger;
}

export function fireFlyToCart(origin: Point | null | undefined): void {
  if (!origin) return;
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return;
  flyTrigger?.(origin);
}

// TEST-ONLY SEAM, the same shape resetHeroRisenForTests is: both registries
// above are module-level and live for a whole test file's run under Jest, so
// one test registering a trigger or a target would otherwise leak into every
// later test that never mounts FlyToCartLayer or CheckoutBar of its own. No
// app code calls this.
export function resetFlyToCartForTests(): void {
  slipTarget = null;
  flyTrigger = null;
}
