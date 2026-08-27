import { Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { PeriodClosePanel } from '@/components/settings/panels/period-close-panel';
import type { Shop } from '@/types/models';

// The switch auto-close shipped without.
//
// 20261003000100 built the whole lazy-close machinery and 20261005000200 said
// out loud that nothing in the app could write its two columns -- so the
// feature was complete, tested, and impossible for any shop to turn on. What
// this file guards is not that a form saves; it is the three things that make
// the form safe to have:
//
//   1. IT SENDS BOTH COLUMNS, in the database's own vocabulary. The mode is a
//      text column with a CHECK of exactly three values and the grace period a
//      CHECK of exactly three integers; a form that offered a fourth of either
//      would write a value the database refuses.
//   2. IT SAYS WHAT TURNING IT ON DOES. For nearly every shop, Automatic is the
//      first time a month will ever have closed itself, and closing a month
//      changes where later postings land. The warning is attached to the CHOICE
//      -- it appears when Automatic is picked and not before, so it is read
//      rather than skipped as boilerplate.
//   3. IT PRINTS THE DATABASE'S SENTENCE when the write is refused. `shops` is
//      updated directly under RLS, and a PostgrestError is a plain object that
//      is never `instanceof Error`.

const mockUpdate = jest.fn((..._args: unknown[]) => Promise.resolve({} as Shop));

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/shops', () => ({
  updateShop: (...args: unknown[]) => mockUpdate(...(args as [])),
}));

function shop(over: Partial<Shop> = {}): Shop {
  return {
    id: 'shop-1',
    // Only the fields this panel reads matter; the rest of Shop is irrelevant
    // to it and is cast rather than invented.
    autoClosePeriods: 'ask',
    periodCloseGraceDays: 10,
    ...over,
  } as Shop;
}

// Every tree is unmounted after its test. A successful save starts a two-second
// "Saved ✓" timer; left mounted, that timer keeps the jest worker alive past the
// run and prints a "did not exit" warning on a green suite.
const mounted: ReactTestRenderer[] = [];

async function render(s: Shop): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(<PeriodClosePanel shop={s} onSaved={async () => {}} />);
  });
  mounted.push(tree!);
  return tree!;
}

function texts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => (Array.isArray(node.props.children) ? node.props.children : [node.props.children]))
    .filter((child): child is string => typeof child === 'string');
}

/** Only the composite Pressables — findAll walks the host views they render too. */
function buttons(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll(
    (node) => node.props?.role === 'button' && typeof node.props?.onPress === 'function'
  );
}

function press(tree: ReactTestRenderer, label: string) {
  const node = buttons(tree).find((b) =>
    b
      .findAllByType(Text)
      .some((t) =>
        (Array.isArray(t.props.children) ? t.props.children : [t.props.children]).some(
          (child) => typeof child === 'string' && child === label
        )
      )
  );
  if (!node) throw new Error(`no button labelled ${label}`);
  return node;
}

/** The nth "Use this" — the modes render in order: automatic, ask, never. */
function chooseMode(tree: ReactTestRenderer, index: number) {
  const choices = buttons(tree).filter((b) =>
    b
      .findAllByType(Text)
      .some((t) =>
        (Array.isArray(t.props.children) ? t.props.children : [t.props.children]).some(
          (child) => typeof child === 'string' && (child === 'Use this' || child === 'In use')
        )
      )
  );
  return choices[index];
}

beforeEach(() => {
  mockUpdate.mockClear();
  mockUpdate.mockImplementation(() => Promise.resolve({} as Shop));
});

afterEach(async () => {
  await act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
});

describe('the modes it offers', () => {
  it('offers exactly the three the column admits, and no fourth', async () => {
    const drawn = texts(await render(shop()));
    expect(drawn).toContain('Close them for me');
    expect(drawn).toContain('Ask me first');
    expect(drawn).toContain('Never');
    // Three mode buttons, and exactly one of them says it is in force.
    expect(drawn.filter((t) => t === 'Use this' || t === 'In use')).toHaveLength(3);
    expect(drawn.filter((t) => t === 'In use')).toHaveLength(1);
  });

  it('shows the shop s current mode as the one in use', async () => {
    const tree = await render(shop({ autoClosePeriods: 'never' }));
    // 'never' is the third, so the first two must read "Use this".
    expect(chooseMode(tree, 2)!.findAllByType(Text)[0].props.children).toBe('In use');
    expect(chooseMode(tree, 0)!.findAllByType(Text)[0].props.children).toBe('Use this');
  });

  it('offers exactly 5, 10 and 15 days, because the database refuses anything else', async () => {
    const drawn = texts(await render(shop()));
    expect(drawn.filter((t) => t.endsWith(' days'))).toEqual(['5 days', '10 days', '15 days']);
  });
});

describe('what turning it on does', () => {
  it('says nothing alarming while the shop is on the safe default', async () => {
    const drawn = texts(await render(shop()));
    expect(drawn.some((t) => t.includes('has ever closed by itself'))).toBe(false);
  });

  it('explains, when automatic is picked, that no month has ever closed itself before', async () => {
    const tree = await render(shop());
    await act(async () => {
      chooseMode(tree, 0)!.props.onPress();
    });
    const drawn = texts(tree);
    expect(drawn).toContain('What turning this on does');
    expect(drawn.some((t) => t.includes('no month in kaiibi has ever closed by itself before'))).toBe(true);
  });

  it('names the import consequence, which is the one that does not look like a bug', async () => {
    const tree = await render(shop());
    await act(async () => {
      chooseMode(tree, 0)!.props.onPress();
    });
    const drawn = texts(tree);
    // An imported sale keeps its date while its entry moves, so two reports
    // disagree permanently with everything still balancing.
    expect(drawn.some((t) => t.includes('imported sale keeps its original date'))).toBe(true);
    expect(drawn.some((t) => t.includes('nothing looking wrong'))).toBe(true);
    // ...and that it is reversible, which is what makes the choice a choice
    // rather than a threat.
    expect(drawn.some((t) => t.includes('Every close can be undone'))).toBe(true);
  });

  it('warns about Never too, because a book that never closes is the other failure', async () => {
    const tree = await render(shop());
    await act(async () => {
      chooseMode(tree, 2)!.props.onPress();
    });
    expect(texts(tree)).toContain('Nothing will ever be locked');
  });

  it('works the grace period into a real date, so the number means something', async () => {
    const tree = await render(shop());
    await act(async () => {
      chooseMode(tree, 0)!.props.onPress();
    });
    expect(texts(tree).some((t) => t.includes('August closes on 10 September'))).toBe(true);
  });
});

describe('saving', () => {
  it('will not save until something changes', async () => {
    const tree = await render(shop());
    expect(press(tree, 'Save').props.disabled).toBe(true);
  });

  it('sends both columns in the database s own vocabulary', async () => {
    const tree = await render(shop());
    await act(async () => {
      chooseMode(tree, 0)!.props.onPress();
    });
    await act(async () => {
      press(tree, '15 days').props.onPress();
    });
    await act(async () => {
      press(tree, 'Save').props.onPress();
    });
    expect(mockUpdate).toHaveBeenCalledWith('shop-1', {
      autoClosePeriods: 'automatic',
      periodCloseGraceDays: 15,
    });
  });

  it('prints the database s sentence when the write is refused', async () => {
    mockUpdate.mockImplementationOnce(() =>
      Promise.reject({
        code: '23514',
        details: null,
        hint: null,
        message: 'new row for relation "shops" violates check constraint "shops_period_close_grace_days_check"',
      })
    );
    const tree = await render(shop());
    await act(async () => {
      chooseMode(tree, 0)!.props.onPress();
    });
    await act(async () => {
      press(tree, 'Save').props.onPress();
    });
    const drawn = texts(tree);
    expect(drawn).toContain(
      'new row for relation "shops" violates check constraint "shops_period_close_grace_days_check"'
    );
    expect(drawn).not.toContain('Could not save these settings.');
  });
});
