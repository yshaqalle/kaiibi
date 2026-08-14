import { Alert, Platform } from 'react-native';

import { confirmChoice, confirmTriChoice } from '@/lib/confirm';

type AlertButton = { text?: string; style?: string; onPress?: () => void };
type AlertOptions = { cancelable?: boolean; onDismiss?: () => void };

// This suite runs under jest-environment-node (no jsdom), where jest-expo's
// setup aliases `window` to the Node global object rather than a real
// browser window -- so it has no `confirm` of its own to spy on. Give it one
// so `jest.spyOn(window, 'confirm')` below has a property to replace.
if (typeof (window as { confirm?: () => boolean }).confirm !== 'function') {
  (window as { confirm: () => boolean }).confirm = () => false;
}

function setPlatform(os: 'web' | 'ios' | 'android') {
  (Platform as { OS: string }).OS = os;
}

const realOS = Platform.OS;

afterEach(() => {
  setPlatform(realOS as 'web' | 'ios' | 'android');
  jest.restoreAllMocks();
});

describe('confirmChoice on web', () => {
  // react-native-web's Alert.alert is a no-op stub: it renders nothing and
  // never fires a button's onPress, so a promise waiting on it would hang
  // forever. Web has to go through window.confirm instead.
  it('resolves true when window.confirm accepts', async () => {
    setPlatform('web');
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(true);
  });

  it('resolves false when window.confirm cancels', async () => {
    setPlatform('web');
    jest.spyOn(window, 'confirm').mockReturnValue(false);

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(false);
  });

  it('shows the title and message together', async () => {
    setPlatform('web');
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    await confirmChoice('Title', 'Message', 'Save anyway');

    expect(confirmSpy).toHaveBeenCalledWith('Title\n\nMessage');
  });
});

describe('confirmChoice on native', () => {
  it('resolves true when the confirm button is pressed', async () => {
    setPlatform('ios');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as AlertButton[]).find((b) => b.text === 'Save anyway')?.onPress?.();
    });

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    setPlatform('ios');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as AlertButton[]).find((b) => b.style === 'cancel')?.onPress?.();
    });

    await expect(confirmChoice('Title', 'Message', 'Save anyway')).resolves.toBe(false);
  });

  // Not styled 'destructive': this save is recoverable and often the right
  // answer. Red would overstate it and blunt the styling where it is earned.
  it('does not style the confirm button as destructive', async () => {
    setPlatform('ios');
    let captured: AlertButton[] = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      captured = buttons as AlertButton[];
      captured.find((b) => b.style === 'cancel')?.onPress?.();
    });

    await confirmChoice('Title', 'Message', 'Save anyway');

    expect(captured.find((b) => b.text === 'Save anyway')?.style).toBeUndefined();
  });
});

describe('confirmTriChoice on web', () => {
  // window.confirm cannot tell "clicked Cancel" from "hit Escape" apart --
  // both come back as a plain `false`. The safe reading of that ambiguity is
  // 'dismiss' (writes nothing), never 'deny' (writes 'waiting' and puts the
  // recipient back in line to be messaged again).
  it('resolves "confirm" when window.confirm accepts', async () => {
    setPlatform('web');
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    await expect(confirmTriChoice('Title', 'Message', 'Yes', 'No')).resolves.toBe('confirm');
  });

  it('resolves "dismiss", not "deny", when window.confirm is declined', async () => {
    setPlatform('web');
    jest.spyOn(window, 'confirm').mockReturnValue(false);

    await expect(confirmTriChoice('Title', 'Message', 'Yes', 'No')).resolves.toBe('dismiss');
  });
});

describe('confirmTriChoice on native', () => {
  it('resolves "confirm" when the confirm button is pressed', async () => {
    setPlatform('ios');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as AlertButton[]).find((b) => b.text === 'Yes')?.onPress?.();
    });

    await expect(confirmTriChoice('Title', 'Message', 'Yes', 'No')).resolves.toBe('confirm');
  });

  // The explicit negative button is a real, distinct answer -- not the same
  // outcome as a dismissal. This is what makes a deliberate "No, not sent"
  // possible at all.
  it('resolves "deny" when the deny button is pressed, distinct from a dismissal', async () => {
    setPlatform('ios');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as AlertButton[]).find((b) => b.text === 'No')?.onPress?.();
    });

    await expect(confirmTriChoice('Title', 'Message', 'Yes', 'No')).resolves.toBe('deny');
  });

  // Neither button is styled 'cancel' -- there is no button here whose
  // wording invites being misread as "forget this", the exact mis-tap
  // failure the review called out.
  it('styles neither button as cancel', async () => {
    setPlatform('ios');
    let captured: AlertButton[] = [];
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      captured = buttons as AlertButton[];
      captured[0]?.onPress?.();
    });

    await confirmTriChoice('Title', 'Message', 'Yes', 'No');

    expect(captured.some((b) => b.style === 'cancel')).toBe(false);
  });

  // Android's back button / outside tap -- routed through onDismiss to its
  // own 'dismiss' outcome rather than hanging forever (there was no
  // onDismiss at all before this fix) or silently matching a button nobody
  // tapped.
  it('resolves "dismiss" when the dialog is dismissed without a button press', async () => {
    setPlatform('android');
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, _b, options) => {
      (options as AlertOptions | undefined)?.onDismiss?.();
    });

    await expect(confirmTriChoice('Title', 'Message', 'Yes', 'No')).resolves.toBe('dismiss');
  });
});
