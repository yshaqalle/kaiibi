export type KeypadKey =
  | { type: 'char'; value: string }
  | { type: 'space' }
  | { type: 'delete' }
  | { type: 'clear' };

/**
 * Every edit the on-screen keypad can make, as a pure function of the text.
 *
 * Separate from the component so the behaviour is tested without rendering
 * anything -- and so the screen's existing `search` state stays the one place
 * the text lives. The keypad holds none of its own.
 */
export function applyKey(text: string, key: KeypadKey): string {
  switch (key.type) {
    case 'char':
      return text + key.value;
    case 'space':
      return text + ' ';
    case 'delete':
      return text.slice(0, -1);
    case 'clear':
      return '';
  }
}
