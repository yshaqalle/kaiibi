import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import { formatE164ForDisplay, toE164 } from '@/lib/phone-e164';
import { cartSubtotalCents, type StorefrontCart } from '@/lib/storefront-cart';
import { WHATSAPP_BUTTON_GREEN, WHATSAPP_INK, type PaletteColors } from '@/lib/storefront-catalog';
import type { PublicDeliveryArea } from '@/types/models';

// A public page component: data and callbacks only, the same seam every
// other storefront component uses (see ThemeProps in theme-shared.tsx). No
// import of a data layer -- Task 6's caller reads getPublicDeliveryAreas
// (storefront.ts) and hands the result down as `areas`.
//
// place_storefront_order (Task 2, 20260927000000_place_order.sql) is the
// ENFORCEMENT: it re-normalises the phone with its own to_e164, re-looks-up
// the area's fee from storefront_delivery_areas, and rejects an unknown area
// name outright. Everything below is the FRIENDLY half of those same rules --
// so a customer sees why before they submit, not a server error after. If a
// later edit "simplifies" the server checks away because "the form already
// validates this", the form is a courtesy for a customer typing on a phone,
// not a boundary; the server has to assume every field here is a lie.
export type CheckoutDetails = {
  name: string;
  phone: string; // Always toE164's output -- never the raw digits typed.
  fulfilment: 'collect' | 'deliver';
  deliveryArea: string | null;
  deliveryLandmark: string | null;
  // B5: optional, unlike name/phone/landmark -- "anything else they should
  // know" is a courtesy field, and place_storefront_order (p_customer->>'note',
  // c_max_note = 1000) already accepts and stores it either way. Null, never
  // an empty string, when the customer leaves it blank -- the same
  // null-over-empty-string convention deliveryLandmark above follows.
  note: string | null;
};

type Props = {
  cart: StorefrontCart;
  colors: PaletteColors;
  offersDelivery: boolean;
  areas: PublicDeliveryArea[];
  // B1: disables the submit Pressables and its own re-entry guard's UI half
  // -- the guard itself lives in useCheckoutFlow's submit() (theme-shared.tsx),
  // which is the one that actually stops a second RPC call; this only stops
  // a second call from originating here in the first place. Both controls
  // below share this one flag, so pressing either disables the other too.
  submitting: boolean;
  // Regression guard (the defect this shape fixes): a shop having a number
  // is what makes the second button RENDER, never what the order does.
  // "Place order" always calls onSubmit(details, 'direct'); the WhatsApp
  // button, which only exists when this is set, calls onSubmit(details,
  // 'whatsapp'). The caller (useCheckoutFlow's submit) is the one place that
  // reads `via` to pick placeOrder vs placeOrderViaWhatsApp -- it must never
  // re-derive that choice from whether a number exists, or the two controls
  // collapse back into one silent redirect.
  whatsappE164?: string | null;
  onSubmit: (details: CheckoutDetails, via: 'direct' | 'whatsapp') => void;
};

export function CheckoutForm({ cart, colors, offersDelivery, areas, submitting, whatsappE164, onSubmit }: Props) {
  // Property 4: collection-only unless the shop BOTH offers delivery AND has
  // listed at least one area. A shop with delivery on and nothing priced
  // would otherwise show a "Deliver" choice that leads nowhere.
  const canDeliver = offersDelivery && areas.length > 0;

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const [fulfilment, setFulfilment] = useState<'collect' | 'deliver'>('collect');
  const [areaName, setAreaName] = useState<string | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [landmark, setLandmark] = useState('');
  const [landmarkError, setLandmarkError] = useState<string | null>(null);

  // B5: no error state -- there is nothing to validate client-side that the
  // server doesn't already enforce more strictly (c_max_note), and an
  // optional field the customer is free to ignore should never grow a red
  // message under it.
  const [note, setNote] = useState('');

  const goodsCents = cartSubtotalCents(cart);
  const selectedArea = fulfilment === 'deliver' ? areas.find((a) => a.name === areaName) ?? null : null;

  // Reformats the field to the shop's display convention the moment the
  // number is recognised (Property 1: "displays formatE164ForDisplay"), so
  // the customer sees what will actually be dialled rather than what they
  // happened to type. A number toE164 cannot normalise is left exactly as
  // typed, with an explanation, so there is something to correct.
  function handlePhoneBlur() {
    const normalised = toE164(phone);
    if (normalised) {
      setPhone(formatE164ForDisplay(normalised));
      setPhoneError(null);
    } else if (phone.trim() !== '') {
      setPhoneError("We couldn't recognise that phone number. Include the country code, e.g. +252 63 445 6789.");
    }
  }

  function selectFulfilment(next: 'collect' | 'deliver') {
    setFulfilment(next);
    // Switching away from delivery drops whatever was chosen there, so a
    // customer who picks deliver, changes their mind, then picks deliver
    // again starts from an honest blank rather than a stale selection.
    if (next === 'collect') {
      setAreaName(null);
      setAreaError(null);
      setLandmark('');
      setLandmarkError(null);
    }
  }

  function selectArea(next: string) {
    setAreaName(next);
    setAreaError(null);
  }

  function handleSubmit(via: 'direct' | 'whatsapp') {
    const trimmedName = name.trim();
    const normalisedPhone = toE164(phone);
    const wantsDelivery = canDeliver && fulfilment === 'deliver';
    const trimmedLandmark = landmark.trim();

    let ok = true;

    if (!trimmedName) {
      setNameError('Add your name so the shop knows who is ordering.');
      ok = false;
    } else {
      setNameError(null);
    }

    // Property 1: a number toE164 will not normalise is rejected with an
    // explanation and never reaches onSubmit -- never stored raw.
    if (!normalisedPhone) {
      setPhoneError("We couldn't recognise that phone number. Include the country code, e.g. +252 63 445 6789.");
      ok = false;
    } else {
      setPhoneError(null);
    }

    if (wantsDelivery && !areaName) {
      setAreaError('Pick the area this order goes to.');
      ok = false;
    }

    if (wantsDelivery && !trimmedLandmark) {
      setLandmarkError('Describe a landmark near you -- Hargeisa addresses are landmarks, not street numbers.');
      ok = false;
    } else if (wantsDelivery) {
      setLandmarkError(null);
    }

    if (!ok) return;

    onSubmit(
      {
        name: trimmedName,
        phone: normalisedPhone as string,
        fulfilment: wantsDelivery ? 'deliver' : 'collect',
        deliveryArea: wantsDelivery ? areaName : null,
        deliveryLandmark: wantsDelivery ? trimmedLandmark : null,
        note: note.trim() || null,
      },
      via
    );
  }

  // Property 3, the single most important rule on this screen: a total only
  // ever renders once every figure in it is actually known. Collect's fee is
  // always known (zero), so its total shows immediately. Deliver's fee is
  // NOT known until an area is picked, so neither the delivery line nor the
  // total renders before that -- a customer must never meet a number at the
  // door they did not agree to.
  const totalKnown = fulfilment === 'collect' || selectedArea !== null;
  const feeCents = selectedArea?.feeCents ?? 0;

  return (
    <View style={styles.form}>
      <Text style={[styles.label, { color: colors.ink }]}>Your name</Text>
      <TextInput
        testID="checkout-form-name-input"
        style={[styles.input, { borderColor: colors.soft, color: colors.ink }]}
        value={name}
        onChangeText={(t) => {
          setName(t);
          if (nameError) setNameError(null);
        }}
        placeholder="Full name"
        placeholderTextColor={colors.muted}
      />
      {nameError ? <Text style={[styles.error, { color: colors.danger }]}>{nameError}</Text> : null}

      <Text style={[styles.label, styles.spaced, { color: colors.ink }]}>Phone</Text>
      <TextInput
        testID="checkout-form-phone-input"
        style={[styles.input, { borderColor: colors.soft, color: colors.ink }]}
        value={phone}
        onChangeText={(t) => {
          setPhone(t);
          if (phoneError) setPhoneError(null);
        }}
        onBlur={handlePhoneBlur}
        placeholder="e.g. 063 445 6789"
        placeholderTextColor={colors.muted}
        keyboardType="phone-pad"
      />
      {phoneError ? <Text style={[styles.error, { color: colors.danger }]}>{phoneError}</Text> : null}

      {/* Property 4: nothing below this point mounts unless the shop both
          offers delivery AND has priced at least one area -- a disabled
          "Deliver" choice would claim delivery exists when it does not. */}
      {canDeliver ? (
        <>
          <Text style={[styles.label, styles.spaced, { color: colors.ink }]}>How will you get your order?</Text>
          <View style={styles.segmented}>
            <Pressable
              testID="checkout-form-fulfilment-collect"
              accessibilityRole="button"
              onPress={() => selectFulfilment('collect')}
              style={[
                styles.segment,
                { borderColor: colors.soft },
                fulfilment === 'collect' && { backgroundColor: colors.accent, borderColor: colors.accent },
              ]}
            >
              <Text style={[styles.segmentText, { color: fulfilment === 'collect' ? colors.ground : colors.ink }]}>
                Collect
              </Text>
            </Pressable>
            <Pressable
              testID="checkout-form-fulfilment-deliver"
              accessibilityRole="button"
              onPress={() => selectFulfilment('deliver')}
              style={[
                styles.segment,
                { borderColor: colors.soft },
                fulfilment === 'deliver' && { backgroundColor: colors.accent, borderColor: colors.accent },
              ]}
            >
              <Text style={[styles.segmentText, { color: fulfilment === 'deliver' ? colors.ground : colors.ink }]}>
                Deliver
              </Text>
            </Pressable>
          </View>

          {fulfilment === 'deliver' ? (
            <>
              <Text style={[styles.hint, { color: colors.muted }]}>
                Pick the area you&apos;re in, then describe a landmark near you -- Hargeisa addresses are landmarks,
                not street numbers.
              </Text>
              <View style={styles.areas}>
                {areas.map((area) => {
                  const selected = area.name === areaName;
                  return (
                    <Pressable
                      key={area.name}
                      testID={`checkout-form-area-${area.name}`}
                      accessibilityRole="button"
                      onPress={() => selectArea(area.name)}
                      style={[
                        styles.areaRow,
                        { borderColor: colors.soft },
                        selected && { backgroundColor: colors.soft, borderColor: colors.accent },
                      ]}
                    >
                      <Text style={[styles.areaName, { color: colors.ink }]}>{area.name}</Text>
                      <Text style={[styles.areaFee, { color: colors.muted }]}>{formatCents(area.feeCents)}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {areaError ? <Text style={[styles.error, { color: colors.danger }]}>{areaError}</Text> : null}

              <TextInput
                testID="checkout-form-landmark-input"
                style={[styles.input, styles.spaced, { borderColor: colors.soft, color: colors.ink }]}
                value={landmark}
                onChangeText={(t) => {
                  setLandmark(t);
                  if (landmarkError) setLandmarkError(null);
                }}
                placeholder="e.g. behind Maansoor Hotel, blue gate"
                placeholderTextColor={colors.muted}
                multiline
              />
              {landmarkError ? <Text style={[styles.error, { color: colors.danger }]}>{landmarkError}</Text> : null}
            </>
          ) : null}
        </>
      ) : null}

      {/* B5: available to every order, collect or deliver -- a courtesy note
          ("ring the bell, don't call") is just as useful picking up in
          person as it is at the door. */}
      <Text style={[styles.label, styles.spaced, { color: colors.ink }]}>Anything else? (optional)</Text>
      <TextInput
        testID="checkout-form-note-input"
        style={[styles.input, { borderColor: colors.soft, color: colors.ink }]}
        value={note}
        onChangeText={setNote}
        placeholder="e.g. call when you arrive"
        placeholderTextColor={colors.muted}
        multiline
      />

      <View style={[styles.breakdown, { borderTopColor: colors.soft }]}>
        <View style={styles.breakdownRow}>
          <Text style={[styles.breakdownLabel, { color: colors.muted }]}>Goods</Text>
          <Text style={[styles.breakdownValue, { color: colors.ink }]}>{formatCents(goodsCents)}</Text>
        </View>
        {/* Property 3: no Delivery row, and no Total row, until the fee is
            actually known -- see totalKnown above. */}
        {totalKnown && fulfilment === 'deliver' ? (
          <View style={styles.breakdownRow}>
            <Text style={[styles.breakdownLabel, { color: colors.muted }]}>Delivery</Text>
            <Text style={[styles.breakdownValue, { color: colors.ink }]}>{formatCents(feeCents)}</Text>
          </View>
        ) : null}
        {totalKnown ? (
          <View style={styles.breakdownRow}>
            <Text style={[styles.totalLabel, { color: colors.ink }]}>Total</Text>
            <Text style={[styles.totalValue, { color: colors.ink }]}>{formatCents(goodsCents + feeCents)}</Text>
          </View>
        ) : null}
      </View>

      {/* Property 6, stated plainly rather than left implied by the absence
          of a pay button -- the same rule CartSheet's caveat follows. */}
      <Text style={[styles.caveat, { color: colors.muted }]}>You pay on collection or delivery.</Text>

      <Pressable
        testID="checkout-form-submit"
        accessibilityRole="button"
        disabled={submitting}
        onPress={() => handleSubmit('direct')}
        style={[styles.submit, { backgroundColor: colors.accent }, submitting && styles.submitDisabled]}
      >
        <Text style={[styles.submitText, { color: colors.ground }]}>{submitting ? 'Placing order…' : 'Place order'}</Text>
      </Pressable>

      {/* Task 7's property 2, and the fix for the defect that shipped without
          it: TWO controls when the shop has a number, both writing the same
          order -- this one writes it, then opens wa.me prefilled with it.
          Rendered only from `whatsappE164`, exactly like WhatsAppButton and
          Ask elsewhere in this theme set -- lose the button rather than open
          a chat with nobody. Never the only way to order: "Place order"
          above always remains, so selling never depends on the question
          channel. */}
      {whatsappE164 ? (
        <Pressable
          testID="checkout-form-submit-whatsapp"
          accessibilityRole="button"
          disabled={submitting}
          onPress={() => handleSubmit('whatsapp')}
          style={[styles.submitWhatsapp, { backgroundColor: WHATSAPP_BUTTON_GREEN }, submitting && styles.submitDisabled]}
        >
          <Text style={[styles.submitWhatsappText, { color: WHATSAPP_INK }]}>
            {submitting ? 'Placing order…' : 'Send this order on WhatsApp'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 4 },
  label: { fontSize: 12.5, fontWeight: '800' },
  spaced: { marginTop: 14 },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  error: { fontSize: 12, marginTop: 6, fontWeight: '600' },
  hint: { fontSize: 12, marginTop: 8, lineHeight: 16 },
  segmented: { flexDirection: 'row', gap: 8, marginTop: 6 },
  segment: { flex: 1, borderWidth: 1, borderRadius: 999, paddingVertical: 9, alignItems: 'center' },
  segmentText: { fontSize: 13, fontWeight: '800' },
  areas: { marginTop: 10, gap: 8 },
  areaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  areaName: { fontSize: 13.5, fontWeight: '700' },
  areaFee: { fontSize: 12.5, fontWeight: '600' },
  breakdown: { marginTop: 16, paddingTop: 12, borderTopWidth: 1, gap: 6 },
  breakdownRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  breakdownLabel: { fontSize: 13, fontWeight: '600' },
  breakdownValue: { fontSize: 13, fontWeight: '700' },
  totalLabel: { fontSize: 14, fontWeight: '800' },
  totalValue: { fontSize: 16, fontWeight: '800' },
  caveat: { fontSize: 12, marginTop: 10, lineHeight: 16 },
  submit: { marginTop: 14, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  submitDisabled: { opacity: 0.6 },
  submitText: { fontSize: 14, fontWeight: '800' },
  // WhatsApp's own fixed brand colours -- never the shop's palette, the same
  // rule ProductActions' Ask button and WhatsAppButton follow (theme-shared.tsx).
  submitWhatsapp: { marginTop: 10, borderRadius: 999, paddingVertical: 12, alignItems: 'center' },
  submitWhatsappText: { fontSize: 14, fontWeight: '800' },
});
