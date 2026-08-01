import { useState } from 'react';
import { View } from 'react-native';

import { Badge, Btn, PageHeader, Row, Section, Toggle } from '@/components/settings/settings-primitives';

// Phase 2 — UI-only mock panels matching the approved design. All state
// below is local and never persisted; there's no backing Supabase table for
// any of these yet. Wire these up to real data in a follow-up plan once the
// shell itself has shipped and been reviewed.

export function LocationsPanel() {
  const [separateInventory, setSeparateInventory] = useState(false);
  const [combinedReports, setCombinedReports] = useState(false);

  return (
    <View>
      <PageHeader title="Locations" actionLabel="+ Add location" onAction={() => {}} />
      <Section title="Your locations">
        <Row label="Main location" desc="Primary location">
          <Btn onPress={() => {}}>Edit</Btn>
        </Row>
      </Section>
      <Section title="Multiple locations" badge={<Badge variant="pro">Pro</Badge>}>
        <Row label="Separate inventory per location" desc="Each store tracks its own stock">
          <Toggle value={separateInventory} onValueChange={setSeparateInventory} />
        </Row>
        <Row label="Combined sales reports" desc="View all locations in one dashboard">
          <Toggle value={combinedReports} onValueChange={setCombinedReports} />
        </Row>
      </Section>
    </View>
  );
}

export function InventoryAlertsPanel() {
  const [trackExpiry, setTrackExpiry] = useState(false);

  return (
    <View>
      <PageHeader title="Inventory alerts" actionLabel="Save" onAction={() => {}} />
      <Section title="Low stock thresholds">
        <Row label="Default low stock level" desc="Alert when any product drops below this">
          <Btn onPress={() => {}}>Set: 5 units</Btn>
        </Row>
        <Row label="Per-product overrides" desc="Set custom thresholds per SKU">
          <Btn onPress={() => {}}>Manage</Btn>
        </Row>
      </Section>
      <Section title="Expiry tracking" badge={<Badge variant="new">New</Badge>}>
        <Row label="Track expiry dates" desc="Useful for perishable or dated inventory">
          <Toggle value={trackExpiry} onValueChange={setTrackExpiry} />
        </Row>
        <Row label="Expiry warning lead time" desc="Alert this many days before expiry">
          <Btn onPress={() => {}}>Set: 30 days</Btn>
        </Row>
      </Section>
    </View>
  );
}

