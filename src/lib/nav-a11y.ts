// What the ☰ nav says out loud.
//
// Shared by admin-tabs.tsx (phone) and admin-sidebar.tsx (tablet and web),
// which draw the same menu twice. The strings are here rather than inlined in
// both because that is exactly how the two defects this file was written for
// got in: one badge implemented twice, drifting apart unnoticed because
// neither copy was read by a test.
//
// Every one of these turns something that is currently DECORATION into words.
// The red dot on the ☰, the 🔒 on a lapsed row and the pink pill on Orders are
// all invisible to a screen reader, and on a phone the ☰ is the only route to
// Storefront and Orders at all -- so without these the destinations are not
// merely awkward to reach, they are unreachable.

/**
 * The ☰ button itself. The count is spoken as the REAL number, not the "9+"
 * the little pill is clamped to: the pill is clamped because two characters is
 * all that fits on the corner of a 36pt button, which is not a reason to tell
 * somebody listening that they have "nine plus" orders.
 */
export function menuButtonA11yLabel(waiting: number): string {
  if (waiting <= 0) return 'Menu';
  return `Menu, ${waiting} order${waiting === 1 ? '' : 's'} waiting`;
}

/**
 * A row inside the sheet. The name leads, deliberately: the rows are drawn
 * with a leading emoji (🌐, 🛍, ⚙) and a screen reader left to its own devices
 * announces the glyph first -- "globe with meridians, Storefront" -- or, worse,
 * takes the glyph as the whole name.
 *
 * `locked` is said rather than set as `accessibilityState.disabled`, because a
 * locked row is NOT disabled: it still pushes, and it lands on the upgrade wall
 * inside the route (components/module-wall.tsx). Announcing it as disabled
 * would tell a lapsed shop that the way back to paying is shut.
 */
export function menuRowA11yLabel(name: string, opts: { waiting?: number; locked?: boolean } = {}): string {
  const parts = [name];
  if (opts.waiting && opts.waiting > 0) parts.push(`${opts.waiting} waiting`);
  if (opts.locked) parts.push('locked');
  return parts.join(', ');
}
