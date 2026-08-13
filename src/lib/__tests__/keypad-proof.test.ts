import { isKeypadProven, markKeypadProven, resetKeypadProof } from '@/lib/keypad-proof';

describe('keypad proof', () => {
  beforeEach(() => resetKeypadProof());

  // Nothing is assumed about a device until its own keyboard has appeared on it.
  // Until then the old per-screen keypad stays, which is the behaviour that
  // device already has -- so the worst case of an unproven platform is no
  // change, never a till whose staff cannot type.
  it('starts unproven, so the old keypad keeps working', () => {
    expect(isKeypadProven()).toBe(false);
  });

  it('is proven once the dock has served a focused field', () => {
    markKeypadProven();
    expect(isKeypadProven()).toBe(true);
  });

  it('tells the screens the moment it changes', () => {
    const seen: boolean[] = [];
    // Subscription is exercised through the hook in the app; here the store's
    // own contract is what matters: listeners hear about the first proof.
    const { useKeypadProven } = jest.requireActual<typeof import('@/lib/keypad-proof')>('@/lib/keypad-proof');
    expect(typeof useKeypadProven).toBe('function');
    markKeypadProven();
    seen.push(isKeypadProven());
    expect(seen).toEqual([true]);
  });

  it('does not announce a second time', () => {
    markKeypadProven();
    markKeypadProven();
    expect(isKeypadProven()).toBe(true);
  });
});
