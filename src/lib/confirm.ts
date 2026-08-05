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
    ], {
      // Tapping outside the dialog on Android must settle the promise too,
      // or the save is left hanging with its spinner spinning.
      onDismiss: () => resolve(false),
    });
  });
}
