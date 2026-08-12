import { supportsTyping } from '../../modules/hardware-keyboard';

// The till's keyboard.
//
// It exists because a HID barcode scanner IS a hardware keyboard, and both
// platforms answer an attached keyboard by refusing to show their own on-screen
// one. So the single till that scans is the single till that cannot type, and
// there is no public API on either platform to ask for the keyboard back.
//
// What separates this from the keypad it replaces is not how it looks -- the
// keys are the same -- but what it IS. `SearchKeypad` owned a value and wrote to
// it, so it could only ever serve the one field it was handed: the search box.
// Every other input on the till (a discount, a customer search, a price, a note)
// stayed untypeable, and each would have had to be wired up by hand.
//
// This sends KEYSTROKES to whatever the OS says has focus, which is what a
// keyboard does. No field knows it exists, no field is wired to it, and a screen
// written next year is covered without being told. Focus comes from the platform
// itself -- Android's window focus observer, UIKit's text-editing notifications
// -- rather than from any state this app keeps about which field is "active",
// because that copy is exactly what drifts.
//
// Mounted twice: once at the app root, and once inside `AppModal`, because a
// modal is a separate window that an overlay in the root window cannot reach
// over.
export function TillKeypad() {
  // No hooks here, deliberately, and the answer cannot change while the process
  // lives -- a binary either has the native half or it does not -- so this is a
  // stable guard rather than a conditional hook.
  //
  // The require is lazy for the same reason the host is a separate file: it
  // reads the shop's settings, and a static import would put the auth context
  // and the Supabase client into the import graph of every sheet in the app.
  if (!supportsTyping()) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TillKeypadHost } = require('./till-keypad-host') as typeof import('./till-keypad-host');
  return <TillKeypadHost />;
}
