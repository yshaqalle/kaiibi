import { applyKey } from '@/lib/keypad';

describe('applyKey', () => {
  it('appends a character', () => {
    expect(applyKey('she', { type: 'char', value: 'a' })).toBe('shea');
  });

  it('appends a space', () => {
    expect(applyKey('shea', { type: 'space' })).toBe('shea ');
  });

  it('deletes the last character', () => {
    expect(applyKey('shea', { type: 'delete' })).toBe('she');
  });

  // Backspace on nothing is a real thing a finger does, and it must not throw
  // or produce "undefined".
  it('deletes nothing from an empty field', () => {
    expect(applyKey('', { type: 'delete' })).toBe('');
  });

  it('clears everything', () => {
    expect(applyKey('shea butter', { type: 'clear' })).toBe('');
  });

  // Search is case-insensitive across name, SKU, brand, category, tag and
  // barcode, which is why the keypad has no shift key to have a state for.
  it('keeps characters exactly as the key gives them', () => {
    expect(applyKey('', { type: 'char', value: '7' })).toBe('7');
  });
});
