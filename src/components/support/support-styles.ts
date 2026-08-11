import { StyleSheet } from 'react-native';

import { Colors } from '@/constants/theme';

// Shared between support-compose.tsx and support-thread-view.tsx: the label,
// input and send-button blocks in the two forms are styled the same way
// because they are the same control, not by coincidence. Only the properties
// that are genuinely identical in both files live here -- spacing, whether
// the input is multiline, and how big Send is legitimately differ per form
// (compose is a longer scroll; a reply box is one line taller than a chip
// label needs) and stay local so this module never forces them into lockstep.
const theme = Colors.light;

export const supportStyles = StyleSheet.create({
  label: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoRule,
    borderRadius: 12,
    fontSize: 13.5,
    color: theme.bentoInk,
  },
  send: {
    backgroundColor: theme.bentoInk,
    borderRadius: 999,
    alignItems: 'center',
  },
  sendOff: { backgroundColor: theme.bentoSoft },
  sendText: { fontWeight: '800', color: theme.bentoSurface },
  sendTextOff: { color: theme.bentoMuted2 },
});
