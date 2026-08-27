import { act, create, type ReactTestInstance } from 'react-test-renderer';

import {
  isReportView,
  REPORT_VIEWS,
  ReportsHub,
  reportViewMeta,
  STATEMENTS_CARD,
  visibleReportViews,
  type ReportView,
} from '@/components/accounting/reports/reports-hub';
import type { Permission } from '@/lib/permissions';

const holding =
  (...granted: Permission[]) =>
  (permission: Permission) =>
    granted.includes(permission);

describe('the reports catalogue', () => {
  it('marks exactly the reports that are buildable today as available', () => {
    // The seven that read tables which already exist. If an eighth appears
    // here without its data, the hub links to an empty screen.
    expect(REPORT_VIEWS.filter((v) => v.available).map((v) => v.key)).toEqual([
      'sales',
      'item',
      'employee',
      'category',
      'inventory',
      'lowstock',
      'movement',
    ]);
  });

  it('gives every unavailable report a reason, because the card renders it', () => {
    for (const v of REPORT_VIEWS) {
      if (v.available) continue;
      expect(v.waitingOn.length).toBeGreaterThan(0);
    }
  });

  it('gives every report a group, a scope and a blurb', () => {
    for (const v of REPORT_VIEWS) {
      if (v.key === 'hub') continue;
      expect(v.group.length).toBeGreaterThan(0);
      expect(v.scope.length).toBeGreaterThan(0);
      expect(v.blurb.length).toBeGreaterThan(0);
    }
  });

  it('resolves an unknown view to the hub rather than rendering nothing', () => {
    const resolve = (raw?: string): ReportView =>
      REPORT_VIEWS.some((v) => v.key === raw) ? (raw as ReportView) : 'hub';
    expect(resolve('lowstock')).toBe('lowstock');
    expect(resolve('nonsense')).toBe('hub');
    expect(resolve(undefined)).toBe('hub');
  });

  it('is the shell that guards the URL, and it knows the hub and the legacy view too', () => {
    // The resolver above is the shape of the guard, not the guard itself: the
    // shell has to admit `hub` and `statements`, which are routable and are not
    // cards. A guard written against REPORT_VIEWS alone would bounce a reader
    // off ?view=statements and quietly delete a working P&L.
    expect(isReportView('hub')).toBe(true);
    expect(isReportView('statements')).toBe(true);
    expect(isReportView('lowstock')).toBe(true);
    expect(isReportView('nonsense')).toBe(false);
    expect(isReportView(undefined)).toBe(false);
  });

  it('routes the Reports tab this hub replaced, so it is not deleted by omission', () => {
    // The existing reports-tab.tsx holds a working P&L, a sales-tax summary and
    // a labour ratio. Replacing that with four cards saying "not yet" is the one
    // outcome this phase must not produce -- so its view stays routable, and it
    // keeps a card, even though it is not one of the eleven the design draws.
    expect(isReportView('statements')).toBe(true);
    expect(REPORT_VIEWS.some((v) => v.key === 'statements')).toBe(false);
    expect(STATEMENTS_CARD.available).toBe(true);
  });

  it('names every view the title row has to label, hub included', () => {
    // The shell reads its title and blurb out of this catalogue. A view it can
    // route to but cannot name renders a headed screen with no heading.
    for (const key of [...REPORT_VIEWS.map((v) => v.key), 'statements' as const, 'hub' as const]) {
      expect(reportViewMeta(key).label.length).toBeGreaterThan(0);
      expect(reportViewMeta(key).blurb.length).toBeGreaterThan(0);
    }
  });

  it('does not promise a fixed window to a screen that follows the picker', () => {
    // "7 days" is only the picker's opening preset. A card that names a window
    // the screen does not keep is a card that gets believed -- the same defect
    // the ledger hub's statement cards were fixed for.
    for (const v of REPORT_VIEWS) {
      if (!v.followsRange) continue;
      expect(v.scope).toBe('7 days');
    }
    // ...and the ones that ignore it say so rather than naming a window.
    expect(REPORT_VIEWS.find((v) => v.key === 'inventory')?.followsRange).toBe(false);
    expect(REPORT_VIEWS.find((v) => v.key === 'lowstock')?.followsRange).toBe(false);
  });

  it('gates nothing, because every report reads a table under RLS rather than an RPC', () => {
    // The rule the ledger hub set: gate a card whose door RAISES, leave open a
    // card whose door returns nothing. All seven read tables directly, so a
    // reader without the permission gets an honest empty report. If a later
    // report arrives over a security-definer RPC, this assertion is where the
    // question gets asked.
    expect(visibleReportViews(holding()).map((v) => v.key)).toEqual(
      visibleReportViews(holding('ledger.view', 'ledger.close')).map((v) => v.key)
    );
  });
});

/** Every Text string in a rendered tree, flattened. */
function texts(root: ReactTestInstance): string[] {
  return root
    .findAllByType('Text' as never)
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === 'string');
}

describe('the hub renders what the catalogue says', () => {
  // Rendered, not read off the source. A test that greps a file for a string
  // cannot tell a live card from a dead one, and this project has already
  // shipped a hub card that led to an empty screen with the suite green.
  const renderHub = (onOpen = jest.fn(), rangeLabel: string | null = null) => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<ReportsHub onOpen={onOpen} rangeLabel={rangeLabel} can={() => true} />);
    });
    return { tree, onOpen };
  };

  it('draws a card for every catalogued report and for the tab it replaced', () => {
    const { tree } = renderHub();
    const shown = texts(tree.root);
    for (const v of REPORT_VIEWS) {
      expect(shown).toContain(v.label);
    }
    expect(shown).toContain(STATEMENTS_CARD.label);
  });

  it('opens the view whose card was pressed, so no card can be wired to another', () => {
    // The mis-wiring this catches: two cards built in a loop that both close
    // over the last key, or a card whose onPress names its neighbour.
    for (const v of [...REPORT_VIEWS, STATEMENTS_CARD]) {
      if (!v.available) continue;
      const { tree, onOpen } = renderHub();
      const pressable = tree.root
        .findAll((node) => typeof node.type !== 'string' && Boolean(node.props.onPress))
        .find((node) => texts(node).includes(v.label));
      expect(pressable).toBeDefined();
      act(() => {
        pressable!.props.onPress();
      });
      expect(onOpen).toHaveBeenCalledWith(v.key);
      expect(onOpen).toHaveBeenCalledTimes(1);
    }
  });

  it('gives an unavailable card no press target at all, rather than one that refuses', () => {
    const { tree } = renderHub();
    for (const v of REPORT_VIEWS) {
      if (v.available) continue;
      const pressable = tree.root
        .findAll((node) => typeof node.type !== 'string' && Boolean(node.props.onPress))
        .find((node) => texts(node).includes(v.label));
      expect(pressable).toBeUndefined();
    }
  });

  it('renders the reason on an unavailable card, in place of its action', () => {
    const { tree } = renderHub();
    const shown = texts(tree.root);
    for (const v of REPORT_VIEWS) {
      if (v.available) continue;
      expect(shown).toContain(v.waitingOn);
    }
  });

  it('shows the picker’s real window on cards that follow it, not a fixed "7 days"', () => {
    // The static scope is only the fallback for before the picker has reported.
    // Once it has, a card that follows the range says what the range IS.
    const { tree } = renderHub(jest.fn(), '1–14 Aug');
    const shown = texts(tree.root);
    expect(shown).toContain('1–14 Aug');
    // ...and a screen that ignores the picker still says so.
    expect(shown).toContain('As of today');
  });
});
