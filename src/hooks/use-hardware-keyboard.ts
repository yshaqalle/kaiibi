import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { getHardwareKeyboardModule } from '../../modules/hardware-keyboard';

// Is a physical keyboard attached right now?
//
//   true  -- one is, confirmed by the OS
//   false -- none is, confirmed by the OS
//   null  -- the platform could not answer: web, or a binary built before the
//            native module existed
//
// `null` is NOT `false`, and callers that collapse the two are wrong in a way
// that is invisible until someone's till stops scanning. See
// `resolveScannerSettings`, which is where the difference is spent.
export function useHardwareKeyboard(): boolean | null {
  const [attached, setAttached] = useState<boolean | null>(read);

  useEffect(() => {
    const module = getHardwareKeyboardModule();
    if (Platform.OS === 'web' || !module) return;

    const subscription = module.addListener('onChange', (event) => setAttached(event.attached));
    return () => subscription.remove();
  }, []);

  return attached;
}

function read(): boolean | null {
  if (Platform.OS === 'web') return null;
  const module = getHardwareKeyboardModule();
  if (!module) return null;
  try {
    return module.isAttached();
  } catch {
    return null;
  }
}
