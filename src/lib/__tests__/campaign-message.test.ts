import { fillMessage, PLACEHOLDERS, type MessageValues } from '@/lib/campaign-message';

const VALUES: MessageValues = {
  name: 'Hodan',
  shop: 'Suuqa Xamar',
  offer: '20% off everything',
  ends: 'Saturday',
  branch: 'Xamar branch',
};

describe('fillMessage', () => {
  it('replaces every placeholder it knows', () => {
    const out = fillMessage('Hi {name} — {offer} at {shop} until {ends}. {branch}.', VALUES);
    expect(out).toBe('Hi Hodan — 20% off everything at Suuqa Xamar until Saturday. Xamar branch.');
  });

  it('replaces a placeholder used more than once', () => {
    expect(fillMessage('{name}, yes {name}', VALUES)).toBe('Hodan, yes Hodan');
  });

  it('leaves text with no placeholders alone', () => {
    expect(fillMessage('Just a plain message', VALUES)).toBe('Just a plain message');
  });

  it('leaves an unknown placeholder exactly as written', () => {
    // Better a visible {total} in the draft than a silently empty gap the
    // owner only notices after sending.
    expect(fillMessage('Hi {name}, you owe {total}', VALUES)).toBe('Hi Hodan, you owe {total}');
  });

  it('does not re-expand a value that itself looks like a placeholder', () => {
    // A shop literally named "{name}" must not turn into the customer's name.
    const out = fillMessage('{shop} says hi to {name}', { ...VALUES, shop: '{name}' });
    expect(out).toBe('{name} says hi to Hodan');
  });

  it('substitutes an empty string for a value that is empty', () => {
    expect(fillMessage('Ends {ends}', { ...VALUES, ends: '' })).toBe('Ends ');
  });

  it('exposes the placeholder list the composer offers', () => {
    expect(PLACEHOLDERS).toEqual(['{name}', '{shop}', '{offer}', '{ends}', '{branch}']);
  });
});
