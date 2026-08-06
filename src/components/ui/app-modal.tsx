// eslint-disable-next-line no-restricted-imports -- this IS the wrapper the rule points everything else at
import { Modal, type ModalProps } from 'react-native';

// Every orientation any device in this app declares, INCLUDING upside-down,
// which app.json grants iPad. The rule is that a modal must never be more
// restrictive than the app it opens over: whatever is left out here is an
// orientation the device can be held in but the modal will force it out of,
// which is the bug described below. Being more permissive is harmless by
// comparison -- iOS intersects this with the window's own supported set, so an
// orientation listed here but withheld by the plist (upside-down on iPhone)
// simply never happens.
//
// So this stays a superset of app.json's orientations. There is no need to keep
// the two exactly equal, only to keep this one from being narrower.
const MODAL_ORIENTATIONS: ModalProps['supportedOrientations'] = [
  'portrait',
  'portrait-upside-down',
  'landscape-left',
  'landscape-right',
];

// The only place in the app that renders React Native's `Modal` directly.
// Everything else uses this, and eslint.config.js enforces it by banning the
// `Modal` import from 'react-native' everywhere but here.
//
// The reason is `supportedOrientations`, which React Native defaults to
// `['portrait']`. A modal host is a presented view controller that answers
// `supportedInterfaceOrientations` for ITSELF out of that prop -- neither the
// Info.plist nor expo-screen-orientation is consulted -- so a default-configured
// modal opened on a device held in landscape force-rotates the whole scene to
// portrait. Several of them opening and closing in quick succession stack up
// `_UIForcedOrientationTransactionToken`s that never commit, and iOS suspends
// interaction while any is outstanding: a screen fully drawn and idle at ~1% CPU
// that accepts no touches, while the native tab bar still switches tabs. That
// froze the POS, which opens the most modals in the shortest time (checkout
// sheet -> receipt).
//
// Setting the prop is the documented fix, but it had to be set on all ~45
// modals, and the next one anyone added would have defaulted back to portrait
// and quietly reintroduced the freeze. Hence one component, plus a lint rule,
// instead of a value 45 call sites have to remember.
//
// A default parameter rather than a hardcoded prop, so a caller that genuinely
// needs a narrower set can still say so -- it just has to say so deliberately.
export function AppModal({ supportedOrientations = MODAL_ORIENTATIONS, ...rest }: ModalProps) {
  return <Modal supportedOrientations={supportedOrientations} {...rest} />;
}
