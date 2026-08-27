import { act, create, type ReactTestInstance } from 'react-test-renderer';

import {
  isReportView,
  LEDGER_STATEMENT_CARDS,
  REPORT_VIEWS,
  ReportsHub,
  reportViewMeta,
  STATEMENTS_CARD,
  VALUATION_CARD,
  visibleReportViews,
  type ReportView,
} from '@/components/accounting/reports/reports-hub';
import type { Permission } from '@/lib/permissions';

const holding =
  (...granted: Permission[]) =>
  (permission: Permission) =>
    granted.includes(permission);

/** Every card the hub can render, for a reader nothing is hidden from. */
const allCards = () => visibleReportViews(holding('ledger.view', 'ledger.close'));

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
    // ...and nothing in this list is anything else. The four cards the design
    // drew as "not yet" are not reports this hub routes to, so they live
    // outside it -- three as doors to the Accounting tab, one as a signpost.
    expect(REPORT_VIEWS.every((v) => v.available)).toBe(true);
  });

  it('gives every unavailable card a reason, because the card renders it', () => {
    for (const v of allCards()) {
      if (v.available) continue;
      expect(v.waitingOn.length).toBeGreaterThan(0);
    }
  });

  it('gives a card a door exactly when it is available', () => {
    // The two drive different things -- `available` the dimming and the footer,
    // `door` the press target -- and a card that is dimmed but pressable, or
    // bright but dead, is the defect either one exists to prevent.
    for (const v of allCards()) {
      expect(v.door !== null).toBe(v.available);
    }
  });

  it('no card claims to be waiting on something that already shipped', () => {
    // Posting landed in 2b (#74) and all three statements in 3a (#80), and FIFO
    // cost layers are parked and superseded by the weighted average in 2a
    // (#73). These four strings shipped from a mockup drawn before any of that
    // and told the reader that working screens did not exist.
    const said = allCards().flatMap((v) => [v.blurb, v.scope, v.waitingOn, v.action]);
    expect(said).not.toContain('Available once sales and bills post to the ledger.');
    expect(said).not.toContain('Available once cost layers land.');
    expect(said).not.toContain('Needs the posting phase');
    expect(said).not.toContain('Needs cost layers');
    expect(said).not.toContain('Not yet');
  });

  it('sends the three statements to the screens that already render them', () => {
    // Not a rewording of "not yet": the cards open the Income Statement, the
    // Balance Sheet and the Cash Flow on the Accounting tab, and `key` IS the
    // ledger view each one opens.
    expect(LEDGER_STATEMENT_CARDS.map((v) => v.key)).toEqual(['income', 'balance', 'cashflow']);
    for (const v of LEDGER_STATEMENT_CARDS) {
      expect(v.available).toBe(true);
      // The action says the press leaves the tab, before it leaves it.
      expect(v.action).toBe('Open in Accounting');
      // statement_lines(), balance_sheet() and cash_flow() are security definer
      // and RAISE without this, and the seeded Manager does not hold it.
      expect(v.requires).toBe('ledger.view');
    }
  });

  it('says what inventory valuation actually is, rather than what it waits for', () => {
    // The one card of the four that is still a signpost, because unlike the
    // three above there is no screen behind it. What it must NOT say is that it
    // is waiting on cost layers: those are parked and superseded, so the thing
    // it claimed to wait for is never landing.
    expect(VALUATION_CARD.available).toBe(false);
    expect(VALUATION_CARD.scope).toBe('Weighted average');
    expect(VALUATION_CARD.waitingOn).toBe('See Inventory Balance');
    expect(VALUATION_CARD.blurb).toContain('moving weighted average');
    // ...and the report it points at is a card on this same hub.
    expect(REPORT_VIEWS.some((v) => v.label === 'Inventory Balance')).toBe(true);
  });

  it('gives every card a group, a scope and a blurb', () => {
    for (const v of allCards()) {
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
    // A ledger view is NOT a report view, even though three cards on this hub
    // open one. `?tab=reports&view=income` has to land on the hub rather than
    // on a blank body, because the Reports tab does not render that screen.
    for (const v of LEDGER_STATEMENT_CARDS) {
      expect(isReportView(v.key)).toBe(false);
    }
  });

  it('routes the Reports tab this hub replaced, so it is not deleted by omission', () => {
    // The existing reports-tab.tsx holds a sales-tax summary and a labour ratio
    // nothing else shows. Replacing that with cards saying "not yet" is the one
    // outcome this phase must not produce -- so its view stays routable, and it
    // keeps a card, even though it is not one of the seven this hub routes to.
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

  it('gates the cards whose door raises, and only those', () => {
    // The rule the ledger hub set: gate a card whose door RAISES, leave open a
    // card whose door returns nothing. All seven reports read tables directly,
    // so a reader without the permission gets an honest empty report. The three
    // statement cards open security-definer RPCs that raise P0001 without
    // ledger.view, so a reader without it is not offered them at all -- and the
    // seeded Manager, who holds sales.view and not ledger.view, is exactly that
    // reader on day one.
    expect(visibleReportViews(holding()).map((v) => v.key)).toEqual([
      'sales',
      'item',
      'employee',
      'category',
      'inventory',
      'lowstock',
      'movement',
      'valuation',
      'statements',
    ]);
    expect(visibleReportViews(holding('ledger.view')).map((v) => v.key)).toEqual([
      'sales',
      'item',
      'employee',
      'category',
      'inventory',
      'lowstock',
      'movement',
      'income',
      'balance',
      'cashflow',
      'valuation',
      'statements',
    ]);
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
  const renderHub = (rangeLabel: string | null = null) => {
    const onOpen = jest.fn();
    const onOpenLedgerView = jest.fn();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ReportsHub onOpen={onOpen} onOpenLedgerView={onOpenLedgerView} rangeLabel={rangeLabel} can={() => true} />
      );
    });
    return { tree, onOpen, onOpenLedgerView };
  };

  /** The pressable wrapping the card with this label, if it has one. */
  const pressableFor = (tree: ReturnType<typeof create>, label: string) =>
    tree.root
      .findAll((node) => typeof node.type !== 'string' && Boolean(node.props.onPress))
      .find((node) => texts(node).includes(label));

  it('draws a card for every catalogued report and for the tab it replaced', () => {
    const { tree } = renderHub();
    const shown = texts(tree.root);
    for (const v of allCards()) {
      expect(shown).toContain(v.label);
    }
    expect(shown).toContain(STATEMENTS_CARD.label);
  });

  it('opens the view whose card was pressed, so no card can be wired to another', () => {
    // The mis-wiring this catches: two cards built in a loop that both close
    // over the last key, or a card whose onPress names its neighbour. Pressed,
    // not grepped -- deleting a view branch once left this suite green with a
    // live card leading to an empty screen.
    for (const v of allCards()) {
      if (!v.available) continue;
      const { tree, onOpen, onOpenLedgerView } = renderHub();
      const pressable = pressableFor(tree, v.label);
      expect(pressable).toBeDefined();
      act(() => {
        pressable!.props.onPress();
      });
      // A card either moves within this hub or hands off to the Accounting
      // tab. Exactly one of the two happens, and with this card's own key.
      const handsOff = v.door?.tab === 'accounting';
      expect(handsOff ? onOpenLedgerView : onOpen).toHaveBeenCalledWith(v.key);
      expect(handsOff ? onOpenLedgerView : onOpen).toHaveBeenCalledTimes(1);
      expect(handsOff ? onOpen : onOpenLedgerView).not.toHaveBeenCalled();
    }
  });

  it('sends Profit & Loss, the Balance Sheet and Cash Flow to the Accounting tab', () => {
    // The whole point of the change: these three said "Not yet" about screens
    // that shipped in 3a. Named individually rather than looped, so a card
    // silently dropped from the catalogue fails here instead of vanishing.
    const expected: [string, string][] = [
      ['Profit & Loss', 'income'],
      ['Balance Sheet', 'balance'],
      ['Cash Flow', 'cashflow'],
    ];
    for (const [label, ledgerView] of expected) {
      const { tree, onOpenLedgerView } = renderHub();
      const pressable = pressableFor(tree, label);
      expect(pressable).toBeDefined();
      act(() => {
        pressable!.props.onPress();
      });
      expect(onOpenLedgerView).toHaveBeenCalledWith(ledgerView);
    }
  });

  it('gives an unavailable card no press target at all, rather than one that refuses', () => {
    const { tree } = renderHub();
    for (const v of allCards()) {
      if (v.available) continue;
      expect(pressableFor(tree, v.label)).toBeUndefined();
    }
    // Concretely: Inventory Valuation is drawn, and pressing it is not a thing.
    expect(texts(tree.root)).toContain('Inventory Valuation');
    expect(pressableFor(tree, 'Inventory Valuation')).toBeUndefined();
  });

  it('renders the reason on an unavailable card, in place of its action', () => {
    const { tree } = renderHub();
    const shown = texts(tree.root);
    for (const v of allCards()) {
      if (v.available) continue;
      expect(shown).toContain(v.waitingOn);
    }
  });

  it('hides a statement card from a reader whose RPC would raise', () => {
    // Dropped rather than dimmed: the dimming means "nothing to show", and one
    // appearance cannot also mean "not yours".
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <ReportsHub onOpen={jest.fn()} onOpenLedgerView={jest.fn()} rangeLabel={null} can={() => false} />
      );
    });
    const shown = texts(tree.root);
    expect(shown).not.toContain('Profit & Loss');
    expect(shown).not.toContain('Cash Flow');
    // ...while the seven reports, which read tables under RLS, are still there.
    expect(shown).toContain('Sales Reports');
    expect(shown).toContain('Inventory Balance');
  });

  it('shows the picker’s real window on cards that follow it, not a fixed "7 days"', () => {
    // The static scope is only the fallback for before the picker has reported.
    // Once it has, a card that follows the range says what the range IS.
    const { tree } = renderHub('1–14 Aug');
    const shown = texts(tree.root);
    expect(shown).toContain('1–14 Aug');
    // ...and a screen that ignores the picker still says so.
    expect(shown).toContain('As of today');
    // The shell owns one range across every tab, so a statement opened from
    // here runs for the window picked here -- except the balance sheet, which
    // is a position at the range's END and says that instead of a window.
    expect(shown).toContain('As at the range end');
  });
});
