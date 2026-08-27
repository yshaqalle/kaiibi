import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Btn, PageHeader, Row, Section } from '@/components/settings/settings-primitives';
import { Colors } from '@/constants/theme';
import { errorMessage } from '@/lib/error-message';
import { updateShop } from '@/lib/shops';
import type { Shop } from '@/types/models';

// Closing the books, and the switch that has had nothing to write it.
//
// 20261003000100 shipped `shops.auto_close_periods` and
// `shops.period_close_grace_days` and the whole lazy-close machinery behind
// them; 20261005000200 moved the default to 'ask' and named the gap out loud
// -- "it is read-only to the app today: getPeriodCloseSettings() reads it and
// nothing writes it". So auto-close has been built, tested and unreachable: no
// shop could turn it on. This panel is the writer.
//
// ## WHY THE COPY IS AS LONG AS IT IS
//
// For almost every shop, switching this to Automatic will be the FIRST TIME A
// MONTH HAS EVER CLOSED ITSELF -- and closing a month is not a report, it
// changes where subsequent postings land. Nothing before phase 3b ever wrote
// `status = 'closed'`, so phase 2b's sixty-six "this period is shut, recognise
// it today instead" branches have never once fired for a real shop. Turning
// this on brings all of them to life at once.
//
// The consequence that actually bites is named on screen rather than left to be
// discovered: a backdated import (lib/sales-import.ts backdates every imported
// historical sale) keeps the SALE's date and redates only its JOURNAL ENTRY, so
// once the months those sales fall in are closed the Sales report and the
// income statement disagree permanently, with every entry balancing and the
// trial balance still at zero. Nothing looks wrong.
//
// That is why 'Ask me first' is the default and why it is described as the
// considered choice rather than the timid one. A setting whose copy says only
// "close months automatically" would be read as a convenience.
//
// ## THE SHAPE FOLLOWS THE EXPIRY PRECEDENT
//
// `expiry_tracking_enabled` + `expiry_warning_lead_days` (0030), written by
// InventoryAlertsPanel: a switch and its number, on `shops`, saved together by
// one Save button off one dirty check. The switch here is three buttons rather
// than a Toggle because the column has three states and a boolean pair is how
// you end up with a fourth that means nothing.
//
// SETTINGS IS NOT A BENTO SCREEN. It reads the grayscale admin palette through
// settings-primitives, and half-applying bento tokens to an unconverted screen
// is the thing the bento skill names first. Everything here is a shared
// primitive.

const theme = Colors.light;

const MODES: { key: Shop['autoClosePeriods']; label: string; desc: string }[] = [
  {
    key: 'automatic',
    label: 'Close them for me',
    desc: 'Each month locks itself once the grace period is up, even if the checklist is not clear — whatever was outstanding is recorded against the month rather than stopping it.',
  },
  {
    key: 'ask',
    label: 'Ask me first',
    desc: 'Nothing closes by itself. Close a Period shows you what is outstanding and refuses until you say to close anyway. This is the default.',
  },
  {
    key: 'never',
    label: 'Never',
    desc: 'No month ever closes on its own. Anyone who can post entries can keep editing any month, for as long as it stays open.',
  },
];

// 5, 10 and 15 exactly — the database's CHECK admits those three and nothing
// else, so a free number field would offer values that raise. Ten is the
// default because August's electricity bill arrives in September.
const GRACE_DAYS = [5, 10, 15];

export function PeriodClosePanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [mode, setMode] = useState<Shop['autoClosePeriods']>(shop.autoClosePeriods);
  const [graceDays, setGraceDays] = useState(shop.periodCloseGraceDays);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The "Saved ✓" flash clears itself after two seconds. Held in a ref and
  // cleared on unmount: the sibling panels leave theirs dangling, and a timer
  // that fires into an unmounted panel is a setState on a dead component --
  // harmless in the app, and in the test suite it is a stray act() warning and
  // a worker that will not exit.
  const flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flash.current) clearTimeout(flash.current); }, []);

  const dirty = mode !== shop.autoClosePeriods || graceDays !== shop.periodCloseGraceDays;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, { autoClosePeriods: mode, periodCloseGraceDays: graceDays });
      await onSaved();
      setSaved(true);
      if (flash.current) clearTimeout(flash.current);
      flash.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      // The database's own sentence. `shops` is written directly under RLS, so
      // a refusal here is a policy violation or a CHECK — and errorMessage()
      // rather than `instanceof Error` because a PostgrestError is a plain
      // object and never an Error.
      setError(errorMessage(err, 'Could not save these settings.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <PageHeader
        title="Closing the books"
        actionLabel={saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
        onAction={save}
        actionDisabled={!dirty || saving}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.lede}>
        Closing a month locks it: sales, bills and payments can no longer post into it, and its profit moves into
        retained earnings. It is what stops last quarter&rsquo;s numbers changing under you.
      </Text>

      <Section title="When a month should close">
        {MODES.map((option) => (
          <Row key={option.key} label={option.label} desc={option.desc}>
            <Btn selected={mode === option.key} onPress={() => setMode(option.key)}>
              {mode === option.key ? 'In use' : 'Use this'}
            </Btn>
          </Row>
        ))}

        {/* THE WARNING BELONGS TO THE CHOICE, so it appears when the choice is
            made rather than sitting permanently where it would be read as
            boilerplate. For most shops this really is the first time a month
            will ever have closed itself. */}
        {mode === 'automatic' ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>What turning this on does</Text>
            <Text style={styles.noticeBody}>
              Once a month is closed, anything dated into it is recorded in the current month instead, carrying its true
              date in the description. That is the right behaviour and it is new to your shop:{' '}
              <Text style={styles.noticeStrong}>no month in kaiibi has ever closed by itself before</Text>, so nothing
              has ever been redirected.
            </Text>
            <Text style={styles.noticeBody}>
              It matters most if you import past sales. An imported sale keeps its original date while its bookkeeping
              entry moves to today, so the Sales report and the income statement would stop agreeing — with every entry
              still balancing and nothing looking wrong. Finish importing your history before you switch this on.
            </Text>
            <Text style={styles.noticeBody}>
              Every close can be undone from Accounting → Close a Period, which reverses the closing entry rather than
              deleting it and asks you to say why.
            </Text>
          </View>
        ) : null}
        {mode === 'never' ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Nothing will ever be locked</Text>
            <Text style={styles.noticeBody}>
              A book that is never closed lets anyone who can post entries edit any month, for ever — which is the thing
              closing exists to prevent. You can still close a month by hand at any time.
            </Text>
          </View>
        ) : null}
      </Section>

      <Section title="How long to wait after a month ends">
        <Row
          label="Grace period"
          desc={
            mode === 'automatic'
              ? `A month that ended is closed ${graceDays} days later — so August closes on ${graceDays} September. Long enough for the bills that arrive after the month they belong to.`
              : 'Only used when months close by themselves. Set it now and it applies the moment you switch that on.'
          }
        />
        <View style={styles.choices}>
          {GRACE_DAYS.map((days) => (
            <Btn key={days} selected={graceDays === days} onPress={() => setGraceDays(days)}>
              {`${days} days`}
            </Btn>
          ))}
        </View>
      </Section>

      <Text style={styles.footnote}>
        Months close when somebody opens Accounting → Close a Period, not on a timer — kaiibi has no scheduler. A shop
        nobody looks at closes nothing until somebody looks, and then closes everything that was due at once.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { fontSize: 13, color: '#6B7280', lineHeight: 20, marginBottom: 22 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 12 },
  notice: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 14,
    marginTop: 14,
    gap: 8,
  },
  noticeTitle: { fontSize: 13, fontWeight: '800', color: '#111111' },
  noticeBody: { fontSize: 12, color: '#6B7280', lineHeight: 18 },
  noticeStrong: { fontWeight: '700', color: '#111111' },
  footnote: { fontSize: 12, color: '#9CA3AF', lineHeight: 18, marginTop: 4 },
  error: { color: theme.danger, fontSize: 13, fontWeight: '700', marginBottom: 16 },
});
