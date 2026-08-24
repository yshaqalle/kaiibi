import { draftDifferenceCents, draftToLines, type DraftLine } from '@/lib/ledger-view';

// The form's own rules, asserted at the boundary the screen calls rather than
// through a render: what it SENDS is the thing that must be right, and a render
// test of a form asserts that a TextInput holds what was typed into it.
describe('what the entry form is allowed to post', () => {
  const canPost = (draft: DraftLine[]): boolean => {
    try {
      const lines = draftToLines(draft);
      return lines.length >= 2 && draftDifferenceCents(draft) === 0;
    } catch {
      return false;
    }
  };

  it('allows a balanced two-line entry', () => {
    expect(canPost([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '840.00', isCredit: true },
    ])).toBe(true);
  });

  it('refuses an entry that is out by a cent', () => {
    expect(canPost([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '1200', amountText: '839.99', isCredit: true },
    ])).toBe(false);
  });

  it('refuses a single line even when the other row is blank', () => {
    expect(canPost([
      { code: '5100', amountText: '840.00', isCredit: false },
      { code: '', amountText: '', isCredit: true },
    ])).toBe(false);
  });

  it('refuses an unreadable amount rather than silently dropping the row', () => {
    // Blank is permissive because nobody filled it in. "abc" is a mistake, and
    // dropping it would post an entry missing a line somebody meant to write.
    //
    // THREE rows, and the other two balance on their own. Written with two
    // first, and it was a test that could not fail: dropping the bad row left a
    // single line, and `lines.length >= 2` refused it for the wrong reason --
    // so the check stayed green with the throw replaced by `continue`. Found by
    // mutation. Here, dropping the row silently leaves a balanced pair, so only
    // the throw can refuse it.
    expect(canPost([
      { code: '5100', amountText: 'abc', isCredit: false },
      { code: '1200', amountText: '100.00', isCredit: false },
      { code: '1000', amountText: '100.00', isCredit: true },
    ])).toBe(false);
  });

  it('allows more than two lines as long as they balance', () => {
    expect(canPost([
      { code: '1000', amountText: '126.40', isCredit: false },
      { code: '4000', amountText: '120.00', isCredit: true },
      { code: '2100', amountText: '6.40', isCredit: true },
    ])).toBe(true);
  });
});
