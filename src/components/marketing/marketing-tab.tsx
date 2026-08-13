import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useDetailSelection, useHeaderActions } from '@/components/accounting/use-header-actions';
import { PromotionsTab, type PromotionsTabProps } from '@/components/marketing/promotions-tab';
import { BentoCard } from '@/components/ui/bento-card';
import { TabPills } from '@/components/ui/tab-pills';
import { Colors } from '@/constants/theme';

// Pinned to the light palette for now — no dark-mode switching yet, matching
// every other bento tab on this screen.
const theme = Colors.light;

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
  const [section, setSection] = useState<MarketingSection>('campaigns');

  // Both sections stay mounted for the lifetime of this component -- see the
  // `display` toggle below -- rather than the conditional-render-per-tab
  // pattern people.tsx uses one level up for Customers/Team/Marketing/etc.
  // That pattern unmounts whichever tab isn't showing, which is fine there
  // (switching from Customers to Team has no reason to remember a customer's
  // scroll position) but wrong here: Campaigns and Offers are two views onto
  // the same job, and flipping between them mid-edit must not discard
  // whatever Offers had open, the same way leaving People for another app
  // screen and coming back doesn't (see the useRefreshOnFocus comment on
  // CustomersTab in people.tsx) -- the app's own tab shell never unmounts
  // People either, only hides it.
  //
  // Each section publishes its header buttons and detail-selected flag into
  // its OWN piece of state here, exactly as it would if it were mounted
  // alone and handed the shell's setters directly. Because both stay
  // mounted, a section switch never runs either child's unmount-cleanup --
  // so the child's own cleanup (inside useHeaderActions/useDetailSelection)
  // isn't what keeps the handoff clean. Instead, THIS component decides,
  // every render, which section's published state is the live one, and
  // forwards only that to the real setters below. The inactive section's
  // buttons are simply never read, so they can't linger; a detail selected
  // in one can't suppress the other's blurb, because each section's flag is
  // only consulted while that section is the active one.
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

      <View style={[styles.section, section !== 'campaigns' && styles.sectionHidden]}>
        <CampaignsPlaceholder />
      </View>
      <View style={[styles.section, section !== 'offers' && styles.sectionHidden]}>
        <PromotionsTab compact={compact} setHeaderActions={setOffersActions} setDetailSelected={setOffersDetailSelected} />
      </View>
    </View>
  );
}

// Honest about where this stands: no fake rows, no spinner waiting on data
// that isn't coming. Task 7 replaces this with the real campaign list.
function CampaignsPlaceholder() {
  return (
    <BentoCard style={styles.placeholderCard}>
      <Text style={styles.placeholderText}>Campaigns are coming soon.</Text>
    </BentoCard>
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
  placeholderCard: { alignItems: 'center' },
  placeholderText: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
});
