import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import { secondaryAmount } from '@/lib/display-currency';
import { fromDateColumn, toDateColumn } from '@/lib/period';
import type { Currency } from '@/types/models';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

/**
 * Let what the payments do not cover be carried on the customer's account.
 *
 * ONE control, not a choice between two. The first attempt offered "Collect it
 * now" beside "Pay later", which read as two behaviours when only one of them
 * was a behaviour -- collecting is the payment methods above this, and a tile
 * meaning "do nothing different" invites a cashier to look for a difference that
 * isn't there.
 *
 * It is also how "some now, the rest later" works, with no third option:
 * whatever has been entered above is what they are paying now, and this carries
 * the difference -- so the amount here moves as payments are entered.
 *
 * Nothing here is ever disabled. With no customer attached it becomes the way to
 * attach one, because "you cannot do this yet" with no way forward is the dead
 * end that made an earlier version of this look broken.
 *
 * Renders nothing when the payments already cover the bill, which is every
 * ordinary sale.
 *
 * ── The due date ──────────────────────────────────────────────────────────
 *
 * Once the choice is made this STATES when the money is due and offers to
 * change it. It never asks. The shop already has a payment term, so the common
 * case -- every sale on the shop's ordinary terms -- costs the cashier no taps
 * at all, and the date is visible to be read out to the customer.
 *
 * Changing it expands INLINE rather than opening a sheet. On a phone this
 * control is already inside the checkout sheet, and a sheet opened from a
 * sheet is dropped on iOS -- the failure that looks like a dead button. An
 * inline expansion has no such problem, and on a control this small it is also
 * fewer surfaces for the same four choices.
 */

/** Whole days added to a local calendar day, as a `date` column value. */
function dayPlus(days: number, from: Date): string {
  const at = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return toDateColumn(at);
}

export function RestChoice({
  remainingCents,
  collectedCents,
  chosen,
  customerName,
  currency,
  dueOn,
  defaultTermDays,
  onChange,
  onDueOnChange,
  onNeedCustomer,
}: {
  remainingCents: number;
  collectedCents: number;
  chosen: boolean;
  customerName: string | null;
  currency: Currency | null;
  /**
   * An explicitly chosen due date as 'YYYY-MM-DD', or null for the shop's
   * usual term.
   *
   * Null rather than the computed date, so the CALLER never has to work out
   * what "usual" resolves to. That matters beyond tidiness: computing it in the
   * POS screen's render meant calling `new Date()` there, which the React
   * Compiler rightly refuses as an impure render. The date is derived here,
   * once, from the same list the options are built from -- so what the control
   * shows and what the options offer cannot disagree.
   */
  dueOn: string | null;
  /** The shop's own term, so one option can be marked as the shop's policy. */
  defaultTermDays: number;
  onChange: (chosen: boolean) => void;
  onDueOnChange: (dueOn: string) => void;
  onNeedCustomer: () => void;
}) {
  const [changing, setChanging] = useState(false);

  // Built from today, once. The named terms exist because "in two weeks" is how
  // a shopkeeper thinks about a variation -- making them count days on a
  // calendar to express it is the tax the shop-wide default removed.
  const options = useMemo(() => {
    const today = new Date();
    const terms = [...new Set([0, 14, defaultTermDays, 60])].sort((a, b) => a - b);
    return terms.map((days) => ({
      days,
      date: dayPlus(days, today),
      label: days === 0 ? 'On collection' : `In ${days} days`,
      // Naming the shop's own term teaches a cashier that a policy exists and
      // that they are about to depart from it -- most of what keeps a per-sale
      // override from quietly becoming the norm.
      isDefault: days === defaultTermDays,
    }));
  }, [defaultTermDays]);

  // What the database will stamp if nobody touches this, computed from the very
  // same options list the cashier picks from.
  const effectiveDueOn = dueOn ?? options.find((option) => option.isDefault)!.date;

  if (remainingCents <= 0) return null;

  const amount = formatCents(remainingCents);
  const secondary = secondaryAmount(remainingCents, currency);
  // "the remaining" only once something has actually been taken. On an untouched
  // bill there is nothing remaining -- it is all of it.
  const what = collectedCents > 0 ? `the remaining ${amount}` : amount;

  // No customer yet. Live, in full ink, and its action opens the picker -- the
  // server refuses a nameless debt, so this is that rule turned into the next
  // step rather than into a locked door.
  if (!customerName) {
    return (
      <Pressable onPress={onNeedCustomer} accessibilityRole="button" style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Pay later</Text>
          <Text style={styles.action}>Attach a customer</Text>
        </View>
        <Text style={styles.detail}>Carry {what} on a customer&apos;s account</Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.card, chosen && styles.cardOn]}>
      {/* The card stopped being one big Pressable when the due line arrived:
          nesting a "Change" button inside a switch makes one control that
          reports two different things to a screen reader, and on web the inner
          press bubbles straight back out and undoes the choice. */}
      <Pressable
        onPress={() => onChange(!chosen)}
        accessibilityRole="switch"
        accessibilityState={{ checked: chosen }}
      >
        <View style={styles.head}>
          <Text style={[styles.title, chosen && styles.titleOn]}>
            {chosen ? 'Paying later' : 'Pay later'}
          </Text>
          <Text style={[styles.action, chosen && styles.actionOn]}>{chosen ? 'Undo' : 'Choose'}</Text>
        </View>
        <Text style={[styles.detail, chosen && styles.detailOn]}>
          {chosen
            ? `${what} carried on ${customerName}'s account`
            : `Carry ${what} on ${customerName}'s account`}
        </Text>
        {/* The figure the customer will be told, in the words they hear it in. */}
        {chosen && secondary !== null && <Text style={styles.echo}>{secondary}</Text>}
      </Pressable>

      {chosen && (
        <>
          <View style={styles.dueRow}>
            <Text style={styles.due}>
              Due {fromDateColumn(effectiveDueOn).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}
            </Text>
            <Pressable
              onPress={() => setChanging((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel={changing ? 'Keep this due date' : 'Change the due date'}
              hitSlop={8}
            >
              <Text style={styles.change}>{changing ? 'Done' : 'Change'}</Text>
            </Pressable>
          </View>

          {changing && (
            <View style={styles.terms}>
              {options.map((option) => {
                const active = option.date === effectiveDueOn;
                return (
                  <Pressable
                    key={option.days}
                    onPress={() => {
                      onDueOnChange(option.date);
                      setChanging(false);
                    }}
                    accessibilityRole="button"
                    aria-selected={active}
                    style={[styles.term, active && styles.termOn]}
                  >
                    <Text style={[styles.termText, active && styles.termTextOn]}>
                      {option.label}
                      {option.isDefault ? ' · usual' : ''}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 14,
    borderRadius: BENTO_RADIUS_TILE,
    backgroundColor: theme.bentoSoft,
  },
  // The accent wash is bento's "this is chosen" signal. Not a status colour, so
  // it says selected without saying good or bad.
  cardOn: { backgroundColor: theme.bentoAccentWash },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { fontSize: 14, fontWeight: '800', color: theme.bentoInk },
  titleOn: { color: theme.bentoAccentInk },
  action: { flexShrink: 0, fontSize: 11.5, fontWeight: '800', color: theme.bentoMuted, letterSpacing: 0.3 },
  actionOn: { color: theme.bentoAccentInk },
  detail: { fontSize: 11.5, fontWeight: '600', color: theme.bentoMuted, marginTop: 3, lineHeight: 16 },
  detailOn: { color: theme.bentoAccentInk },
  echo: { fontSize: 10, fontWeight: '600', color: theme.bentoAccentInk, marginTop: 2, opacity: 0.85 },
  dueRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 7 },
  due: { fontSize: 11.5, fontWeight: '800', color: theme.bentoAccentInk },
  // Underlined because it is the one thing here that is a link rather than a
  // statement, and the card is already an accent wash -- colour alone would not
  // separate them.
  change: { fontSize: 11, fontWeight: '800', color: theme.bentoAccentInk, textDecorationLine: 'underline' },
  terms: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  term: { backgroundColor: theme.bentoSurface, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  termOn: { backgroundColor: theme.bentoAccentInk },
  termText: { fontSize: 11, fontWeight: '800', color: theme.bentoAccentInk },
  termTextOn: { color: theme.bentoSurface },
});
