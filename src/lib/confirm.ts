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
