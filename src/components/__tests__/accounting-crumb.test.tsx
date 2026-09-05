import { act, create, type ReactTestInstance } from 'react-test-renderer';

import { AccountingCrumb, type CrumbStep } from '@/components/accounting/accounting-crumb';

// The narrow case is a width read, so the tests drive the width rather than the
// component -- 380 is a phone, 1400 a desktop, and TABLET_BREAKPOINT (820) is
// the line between them.
let mockWidth = 1400;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockWidth, height: 900, scale: 1, fontScale: 1 }),
}));

const render = (trail: CrumbStep[]) => {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<AccountingCrumb trail={trail} />);
  });
  return tree;
};

/** Every rendered string, in order, so the crumb can be read as one line. */
const line = (tree: ReturnType<typeof create>): string =>
  tree.root
    .findAllByType('Text' as never)
    .map((t: ReactTestInstance) => (Array.isArray(t.props.children) ? t.props.children.join('') : String(t.props.children ?? '')))
    .join(' ');

const pressables = (tree: ReturnType<typeof create>) =>
  tree.root.findAll((n) => typeof n.type === 'string' && typeof n.props.onClick === 'function');

beforeEach(() => {
  mockWidth = 1400;
});

describe('the accounting breadcrumb', () => {
  it('reads as the whole path, ancestors first', () => {
    const tree = render([
      { label: 'Accounting', onPress: () => {} },
      { label: 'The books', onPress: () => {} },
      { label: 'General Journal Entry' },
    ]);
    expect(line(tree)).toContain('Accounting');
    expect(line(tree)).toContain('The books');
    expect(line(tree)).toContain('General Journal Entry');
    // Order matters -- a crumb that lists the leaf first is not a crumb.
    const text = line(tree);
    expect(text.indexOf('Accounting')).toBeLessThan(text.indexOf('The books'));
    expect(text.indexOf('The books')).toBeLessThan(text.indexOf('General Journal Entry'));
  });

  it('makes every ancestor pressable and the leaf not', () => {
    const onModule = jest.fn();
    const onTab = jest.fn();
    const tree = render([
      { label: 'Accounting', onPress: onModule },
      { label: 'The books', onPress: onTab },
      { label: 'General Journal Entry' },
    ]);
    // Two ancestors, so two press targets -- the leaf is where you already are
    // and a link to here is a link that does nothing.
    expect(pressables(tree)).toHaveLength(2);
    act(() => {
      pressables(tree)[1].props.onClick({});
    });
    expect(onTab).toHaveBeenCalled();
    expect(onModule).not.toHaveBeenCalled();
  });

  it('renders a two-step trail for a tab that has no view under it', () => {
    const tree = render([{ label: 'Accounting', onPress: () => {} }, { label: 'Bills' }]);
    expect(line(tree)).toContain('Accounting');
    expect(line(tree)).toContain('Bills');
    expect(pressables(tree)).toHaveLength(1);
  });

  it('collapses the module step to an arrow on a phone, keeping the tap target', () => {
    mockWidth = 380;
    const onModule = jest.fn();
    const tree = render([
      { label: 'Accounting', onPress: onModule },
      { label: 'The books', onPress: () => {} },
      { label: 'General Journal Entry' },
    ]);
    // The word goes, the target stays: still two ancestors to press.
    expect(pressables(tree)).toHaveLength(2);
    expect(line(tree)).not.toContain('Accounting');
    expect(line(tree)).toContain('←');
    // The level that actually distinguishes this screen survives.
    expect(line(tree)).toContain('The books');
    expect(line(tree)).toContain('General Journal Entry');
  });

  it('keeps the module word on a phone when the trail is only two deep', () => {
    mockWidth = 380;
    const tree = render([{ label: 'Accounting', onPress: () => {} }, { label: 'Bills' }]);
    // Nothing to save room for, so nothing is abbreviated.
    expect(line(tree)).toContain('Accounting');
    expect(line(tree)).not.toContain('←');
  });
});
