import { Alert, Platform } from 'react-native';

import { confirmChoice } from '@/lib/confirm';

type AlertButton = { text?: string; style?: string; onPress?: () => void };

// This suite runs under jest-environment-node (no jsdom), where jest-expo's
// setup aliases `window` to the Node global object rather than a real
// browser window -- so it has no `confirm` of its own to spy on. Give it one
// so `jest.spyOn(window, 'confirm')` below has a property to replace.
if (typeof (window as { confirm?: () => boolean }).confirm !== 'function') {
  (window as { confirm: () => boolean }).confirm = () => false;
}

function setPlatform(os: 'web' | 'ios') {
  (Platform as { OS: string }).OS = os;
}

const realOS = Platform.OS;

afterEach(() => {
  setPlatform(realOS as 'web' | 'ios');
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
