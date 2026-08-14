import { Alert, Platform } from 'react-native';

// RN Web's Alert.alert is a no-op stub (react-native-web has no OS dialog to
// back it with) -- it never shows anything and never fires a button's
// onPress, so the confirm has to go through window.confirm there instead.
// See pos.tsx's cart-clear confirm, which this generalizes.
export function confirmDestructive(title: string, message: string, confirmLabel: string, onConfirm: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}

// A confirm that is NOT a warning about damage.
//
// `confirmDestructive` above styles its button red, which is correct for
// deleting a product and wrong for everything that is merely worth a second
// look. Saving a product with no purchase cost is recoverable and often
// deliberate; dressing it as deletion would overstate it and, repeated, blunt
// the red where it is earned.
//
// Promise-returning rather than callback-taking, so it reads as a step inside
// an async submit() rather than splitting the save across a callback.
export function confirmChoice(title: string, message: string, confirmLabel: string): Promise<boolean> {
  // Same web/native split as confirmDestructive, and for the same reason:
  // react-native-web's Alert.alert is a no-op stub, so a promise waiting on
  // its buttons would never settle.
  if (Platform.OS === 'web') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, onPress: () => resolve(true) },
    ]);
  });
}

// A confirm with THREE outcomes, not two -- for exactly one caller
// (send-queue.tsx's "did that send?" question), where dismissing the dialog
// without choosing must NOT read as either button.
//
// confirmChoice above collapses "the negative button" and "dismissed with no
// answer" into the same `false` -- correct for every OTHER caller of it (a
// declined confirmation and a shrugged-off one are the same thing to them),
// and wrong for this one: "did that send?" backs a WRITE that reverts an
// 'opened' recipient to 'waiting', which puts them back in line to be
// messaged AGAIN. A mis-tap outside the dialog must not carry that write; it
// must leave the row exactly as it was.
//
// 'deny' is still a real, reachable outcome -- an owner who opened WhatsApp
// and genuinely didn't send can say so on purpose, and that answer is
// honoured. 'dismiss' is everything that ISN'T a deliberate button press.
export type TriChoiceAnswer = 'confirm' | 'deny' | 'dismiss';

export function confirmTriChoice(title: string, message: string, confirmLabel: string, denyLabel: string): Promise<TriChoiceAnswer> {
  if (Platform.OS === 'web') {
    // window.confirm has exactly two outcomes, OK or Cancel, and a browser
    // gives Escape and the dialog's own close control the SAME Cancel
    // outcome as a deliberate click on it -- there is no way here to tell
    // "I meant no" from "I bumped Escape". The ambiguous case is folded into
    // 'dismiss', the one outcome that writes nothing, rather than into
    // 'deny', which would revert (and re-message) someone the owner never
    // actually said no to.
    return Promise.resolve(window.confirm(`${title}\n\n${message}`) ? 'confirm' : 'dismiss');
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: denyLabel, onPress: () => resolve('deny') },
        { text: confirmLabel, onPress: () => resolve('confirm') },
      ],
      // iOS never dismisses an Alert without a button tap, so `onDismiss`
      // simply never fires there -- 'confirm'/'deny' are the only reachable
      // outcomes, both deliberate. Android's back button and outside tap
      // are real dismissals though, and `cancelable: true` plus this
      // `onDismiss` routes them to their own outcome instead of silently
      // matching neither button (the previous shape here had no `onDismiss`
      // at all, so a back-button dismissal never resolved the promise).
      { cancelable: true, onDismiss: () => resolve('dismiss') }
    );
  });
}
