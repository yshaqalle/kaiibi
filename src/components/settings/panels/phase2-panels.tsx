import { useState } from 'react';
import { View } from 'react-native';

import { Badge, Btn, PageHeader, Row, Section, Toggle } from '@/components/settings/settings-primitives';

// Phase 2 — UI-only mock panels matching the approved design. All state
// below is local and never persisted; there's no backing Supabase table for
// any of these yet. Wire these up to real data in a follow-up plan once the
// shell itself has shipped and been reviewed.

export function SecurityPanel() {
  const [authApp, setAuthApp] = useState(false);
  const [smsVerification, setSmsVerification] = useState(true);

  return (
    <View>
      <PageHeader title="Security" />
      <Section title="Password">
        <Row label="Current password" desc="Last changed 3 months ago">
          <Btn onPress={() => {}}>Change</Btn>
        </Row>
      </Section>
      <Section title="Two-factor authentication">
        <Row label="Authenticator app" desc="Use an app like Google Authenticator">
          <Toggle value={authApp} onValueChange={setAuthApp} />
        </Row>
        <Row label="SMS verification" desc="Receive a code via text message">
          <Toggle value={smsVerification} onValueChange={setSmsVerification} />
        </Row>
      </Section>
      <Section title="Sessions">
        <Row label="Active sessions" desc="This device · now">
          <Btn danger onPress={() => {}}>
            Sign out all
          </Btn>
        </Row>
      </Section>
    </View>
  );
}

export function NotificationsPanel() {
  const [dailySummary, setDailySummary] = useState(true);
  const [largeSaleAlert, setLargeSaleAlert] = useState(true);
  const [lowStockWarning, setLowStockWarning] = useState(true);
  const [outOfStock, setOutOfStock] = useState(true);
  const [pushEnabled, setPushEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [whatsAppEnabled, setWhatsAppEnabled] = useState(false);

  return (
    <View>
      <PageHeader title="Notifications" actionLabel="Save" onAction={() => {}} />
      <Section title="Sales alerts">
        <Row label="Daily sales summary" desc="Sent every evening at 8 PM">
          <Toggle value={dailySummary} onValueChange={setDailySummary} />
        </Row>
        <Row label="Large sale alert" desc="Notify when a single sale exceeds $100">
          <Toggle value={largeSaleAlert} onValueChange={setLargeSaleAlert} />
        </Row>
      </Section>
      <Section title="Inventory alerts">
        <Row label="Low stock warning" desc="Alert when stock drops below threshold">
          <Toggle value={lowStockWarning} onValueChange={setLowStockWarning} />
        </Row>
        <Row label="Out of stock" desc="Immediate push notification">
          <Toggle value={outOfStock} onValueChange={setOutOfStock} />
        </Row>
      </Section>
      <Section title="Delivery channel">
        <Row label="Push notifications">
          <Toggle value={pushEnabled} onValueChange={setPushEnabled} />
        </Row>
        <Row label="Email">
          <Toggle value={emailEnabled} onValueChange={setEmailEnabled} />
        </Row>
        <Row label="WhatsApp" badge={<Badge variant="new">New</Badge>} desc="Send summaries to your WhatsApp number">
          <Toggle value={whatsAppEnabled} onValueChange={setWhatsAppEnabled} />
        </Row>
      </Section>
    </View>
  );
}

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

export function PaymentsPanel() {
  const [cash, setCash] = useState(true);
  const [zaad, setZaad] = useState(true);
  const [eDahab, setEDahab] = useState(false);
  const [evcPlus, setEvcPlus] = useState(false);
  const [card, setCard] = useState(false);
  const [splitPayment, setSplitPayment] = useState(false);

  return (
    <View>
      <PageHeader title="Payments" actionLabel="Save" onAction={() => {}} />
      <Section title="Accepted payment methods">
        <Row label="Cash">
          <Toggle value={cash} onValueChange={setCash} />
        </Row>
        <Row label="ZAAD" desc="Telesom mobile money">
          <Toggle value={zaad} onValueChange={setZaad} />
        </Row>
        <Row label="E-Dahab" desc="Somtel mobile money">
          <Toggle value={eDahab} onValueChange={setEDahab} />
        </Row>
        <Row label="EVC Plus" desc="Hormuud mobile money">
          <Toggle value={evcPlus} onValueChange={setEvcPlus} />
        </Row>
        <Row label="Card">
          <Toggle value={card} onValueChange={setCard} />
        </Row>
      </Section>
      <Section title="Split payment">
        <Row label="Allow split payment" desc="Part cash, part ZAAD in one transaction">
          <Toggle value={splitPayment} onValueChange={setSplitPayment} />
        </Row>
      </Section>
    </View>
  );
}
