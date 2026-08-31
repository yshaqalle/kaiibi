import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

// Every control on the public page used to take a plain style OBJECT, which
// means a tap was registered and never acknowledged. On the connection this
// page is usually opened over -- a WhatsApp in-app browser, on a phone -- that
// silence is indistinguishable from a dropped tap, so the customer presses Add
// again and orders two.
//
// A `style` FUNCTION is how RN says "re-style for the duration of the touch":
// it is called with `{ pressed }` on press-in and again on press-out. That is
// the whole mechanism, and it is why the test for this asks only whether
// `style` is a function -- that a control answers at all is the property worth
// pinning, not the specific opacity, which should stay free to tune.
//
// Opacity AND a slight scale, not one or the other: opacity alone is easy to
// miss on a bright screen outdoors, which is where a lot of this traffic is.
// Both are compositor-only -- neither triggers a layout pass -- so this costs
// nothing on the low-end Android the page has to stay smooth on.
//
// Deliberately NOT gated on reduce-motion. A 3% scale on a control the finger
// is already touching is direct manipulation, not animation: no duration, no
// easing, no travel, and nothing to disable that would not also remove the
// acknowledgement itself. FlyerCarousel's auto-advance is the opposite case
// -- unbidden movement, on a timer -- and gates on it properly. The two are
// not the same thing and should not share a switch.
//
// ---
//
// THIS LIVES IN ITS OWN MODULE, not in theme-shared.tsx, and that is
// structural rather than tidiness. theme-shared imports CheckoutForm and
// OrderPlaced; those two need press feedback as much as anything else does,
// so importing it from theme-shared would close a cycle
// (theme-shared -> checkout-form -> theme-shared). A styling primitive that
// every component may need has to sit below all of them.
export function pressable(base: StyleProp<ViewStyle>) {
  return ({ pressed }: { pressed: boolean }): StyleProp<ViewStyle> =>
    pressed ? [base, styles.pressed] : base;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
});
