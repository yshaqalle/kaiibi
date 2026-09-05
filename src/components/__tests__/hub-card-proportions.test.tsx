import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';

import { LedgerHub } from '@/components/accounting/ledger/ledger-hub';
import { ReportsHub } from '@/components/accounting/reports/reports-hub';
import { Colors } from '@/constants/theme';
import type { Permission } from '@/lib/permissions';

const theme = Colors.light;
const anything = (_permission: Permission) => true;

/**
 * The two hubs hold duplicate copies of one card StyleSheet, so a change made
 * to one and not the other is invisible until somebody opens both tabs. These
 * assertions run against BOTH renders for that reason -- the point is not that
 * the numbers are right, it is that they cannot drift apart.
 */
function renderHubs() {
  let ledger!: ReturnType<typeof create>;
  let reports!: ReturnType<typeof create>;
  act(() => {
    ledger = create(<LedgerHub onOpen={() => {}} accountCount={31} unpostedRows={0} can={anything} />);
    reports = create(
      <ReportsHub onOpen={() => {}} onOpenLedgerView={() => {}} onOpenTab={() => {}} rangeLabel="7 days" can={anything} />,
    );
  });
  return { ledger, reports };
}

/** Every hub card in a tree: the bento Card each Pressable/View wraps. */
const cards = (tree: ReturnType<typeof create>): ReactTestInstance[] =>
  tree.root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      StyleSheet.flatten(node.props.style)?.borderRadius === 26 &&
      StyleSheet.flatten(node.props.style)?.backgroundColor === theme.bentoSurface,
  );

const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};

describe('the hub card', () => {
  it('pads its content away from the card edge', () => {
    // Every other `Card variant="bento"` in the app passes a padding style.
    // These two passed none, so the icon tile sat flush into a 26px corner.
    for (const [name, tree] of Object.entries(renderHubs())) {
      const found = cards(tree);
      expect(found.length).toBeGreaterThan(0);
      for (const card of found) {
        expect({ hub: name, padding: flat(card).padding }).toEqual({ hub: name, padding: 20 });
      }
    }
  });

  it('gives the icon tile, title, blurb and pill the adapted proportions', () => {
    for (const tree of Object.values(renderHubs())) {
      const [card] = cards(tree);
      // The tile is the first child; the texts follow it in order.
      const tile = card.findAll((n) => typeof n.type === 'string' && flat(n).width === 36)[0];
      expect(tile).toBeTruthy();
      expect(flat(tile).height).toBe(36);
      expect(flat(tile).borderRadius).toBe(10);
      // Still the bento fill, NOT the proposal's blue tint.
      expect(flat(tile).backgroundColor).toBe(theme.bentoSoft);

      const texts = card.findAllByType('Text' as never).map(flat);
      const title = texts.find((s) => s.fontSize === 15);
      expect(title).toBeTruthy();
      // Size from the proposal, weight from bento -- 800 is the house voice.
      expect(title?.fontWeight).toBe('800');
      expect(title?.color).toBe(theme.bentoInk);

      const blurb = texts.find((s) => s.fontSize === 12.5 && s.color === theme.bentoMuted);
      expect(blurb).toBeTruthy();
      expect(blurb?.lineHeight).toBe(19);

      // The footer meta keeps the solved grey, not the proposal's #9a9a9e.
      const scope = texts.find((s) => s.fontSize === 11.5 && s.color === theme.bentoMuted2);
      expect(scope).toBeTruthy();
    }
  });

  it('keeps a solid pill for the doors that write, and a quiet one for the rest', () => {
    const { ledger } = renderHubs();
    const pills = ledger.root
      .findAll((n) => typeof n.type === 'string' && flat(n).borderRadius === 999)
      .map(flat);
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill.paddingHorizontal).toBe(14);
      expect(pill.paddingVertical).toBe(7);
    }
    // Both fills still present: a report you read and a book you write to must
    // not look like the same act.
    expect(pills.some((p) => p.backgroundColor === theme.bentoInk)).toBe(true);
    expect(pills.some((p) => p.backgroundColor === theme.bentoSoft)).toBe(true);
  });
});
