import { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useDetailSelection, useHeaderActions } from '@/components/accounting/use-header-actions';
import { CampaignsTab } from '@/components/marketing/campaigns-tab';
import { PromotionsTab, type PromotionsTabProps } from '@/components/marketing/promotions-tab';
import { TabPills } from '@/components/ui/tab-pills';

type MarketingSection = 'campaigns' | 'offers';

const SECTION_OPTIONS: { key: MarketingSection; label: string }[] = [
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'offers', label: 'Offers' },
];

// The Marketing tab used to BE the offers list. It now holds two sections --
// Campaigns (Task 7 fills this in) and Offers (the promotions list, untouched
// below). Takes exactly PromotionsTab's prop shape so people.tsx can swap one
// for the other with no other change at the call site.
export function MarketingTab({ compact, setHeaderActions, setDetailSelected }: PromotionsTabProps) {
  const [section, setSectionState] = useState<MarketingSection>('campaigns');

  // Offers only mounts once it has actually been chosen at least once, so a
  // Marketing visit that never leaves Campaigns (the default section) never
  // pays for Offers' fetch. Campaigns needs no equivalent flag: `section`
  // starts on 'campaigns', so CampaignsTab is already in the tree -- and
  // therefore already fetching -- on the very first render, which IS "first
  // visit". This is the fix for the concern Task 6's review carried forward:
  // before Campaigns had any data of its own, both sections mounting eagerly
  // cost nothing; now that Campaigns fetches too, mounting Offers unread
  // would double that cost on every Marketing visit for no reason.
  const [visitedOffers, setVisitedOffers] = useState(section === 'offers');
  const setSection = useCallback((next: MarketingSection) => {
    setSectionState(next);
    if (next === 'offers') setVisitedOffers(true);
  }, []);

  // Once a section IS mounted, both stay mounted for the rest of this
  // component's lifetime -- see the `display` toggle below -- rather than
  // the conditional-render-per-tab pattern people.tsx uses one level up for
  // Customers/Team/Marketing/etc. That pattern unmounts whichever tab isn't
  // showing, which is fine there (switching from Customers to Team has no
  // reason to remember a customer's scroll position) but wrong here:
  // Campaigns and Offers are two views onto the same job, and flipping
  // between them mid-edit must not discard whatever Offers had open, the
  // same way leaving People for another app screen and coming back doesn't
  // (see the useRefreshOnFocus comment on CustomersTab in people.tsx) -- the
  // app's own tab shell never unmounts People either, only hides it.
  //
  // Each section publishes its header buttons and detail-selected flag into
  // its OWN piece of state here, exactly as it would if it were mounted
  // alone and handed the shell's setters directly. Because both stay
  // mounted once visited, a section switch never runs either child's
  // unmount-cleanup -- so the child's own cleanup (inside
  // useHeaderActions/useDetailSelection) isn't what keeps the handoff
  // clean. Instead, THIS component decides, every render, which section's
  // published state is the live one, and forwards only that to the real
  // setters below. The inactive section's buttons are simply never read, so
  // they can't linger; a detail selected in one can't suppress the other's
  // blurb, because each section's flag is only consulted while that section
  // is the active one.
  const [campaignsActions, setCampaignsActions] = useState<ReactNode>(null);
  const [offersActions, setOffersActions] = useState<ReactNode>(null);
  const [campaignsDetailSelected, setCampaignsDetailSelected] = useState(false);
  const [offersDetailSelected, setOffersDetailSelected] = useState(false);

  const activeActions = section === 'campaigns' ? campaignsActions : offersActions;
  const activeDetailSelected = section === 'campaigns' ? campaignsDetailSelected : offersDetailSelected;

  // Forwards to the REAL shell setters (people.tsx's). This hook's own
  // unmount-cleanup fires when MarketingTab itself unmounts -- switching away
  // from the Marketing tab entirely -- which is exactly when the header
  // buttons and detail-selected flag should clear, same as every other
  // People tab.
  useHeaderActions(setHeaderActions, activeActions, [activeActions]);
  useDetailSelection(setDetailSelected, activeDetailSelected);

  return (
    <View style={styles.body}>
      <View style={styles.tabBar}>
        <TabPills options={SECTION_OPTIONS} value={section} onChange={setSection} />
      </View>

      {/* `accessibilityElementsHidden` / `importantForAccessibility` alongside
          the style, not instead of it: `display: 'none'` removes the section
          from layout and from touch, but a screen reader will still walk a
          subtree that is merely unlaid-out. Without these, VoiceOver and
          TalkBack read the section the person is NOT looking at. Same pairing
          wedge-sink.tsx and app-tabs.web.tsx already use for hidden content. */}
      <View
        style={[styles.section, section !== 'campaigns' && styles.sectionHidden]}
        accessibilityElementsHidden={section !== 'campaigns'}
        importantForAccessibility={section !== 'campaigns' ? 'no-hide-descendants' : 'auto'}
      >
        <CampaignsTab compact={compact} setHeaderActions={setCampaignsActions} setDetailSelected={setCampaignsDetailSelected} />
      </View>
      <View
        style={[styles.section, section !== 'offers' && styles.sectionHidden]}
        accessibilityElementsHidden={section !== 'offers'}
        importantForAccessibility={section !== 'offers' ? 'no-hide-descendants' : 'auto'}
      >
        {/* Not mounted at all until Offers has been chosen once -- see
            `visitedOffers` above. Once true this stays rendered (never goes
            back to `null`), which is what keeps its state alive across
            later section switches via the `display: 'none'` sibling to
            Campaigns' own View, exactly as before. */}
        {visitedOffers && (
          <PromotionsTab compact={compact} setHeaderActions={setOffersActions} setDetailSelected={setOffersDetailSelected} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  tabBar: { marginBottom: 16 },
  section: { flex: 1 },
  // `display: 'none'`, not a conditional unmount -- keeps the section's state
  // (Offers's scroll position, its selected row, its open form) alive while
  // it's out of view. See the header comment above for why that matters here.
  sectionHidden: { display: 'none' },
});
