import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput } from '@/components/date-input';
import { AppModal } from '@/components/ui/app-modal';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { formatAccountingCents, toCents } from '@/lib/currency';
import { errorMessage } from '@/lib/error-message';
import { toDateColumn } from '@/lib/period';
import { listTransferAccounts, transferFunds, type TransferAccount } from '@/lib/transfers';

const theme = Colors.light;

// Moving the shop's own money — and WHY IT LIVES ON CASH & BUDGETS.
//
// The design (accounting-standards-mockup.html) puts "Cash and Bank Transfers"
// on the Accounting hub, under Banking & bills, and says of the tab it came
// from: "Cash & Budgets — unchanged; transfers move to the Accounting hub".
// It is here instead, and the reason is the permission the database chose.
//
//   * transfer_funds GATES ON budgets.manage, not on any ledger.* permission,
//     and 20261006000000's header argues that at length: banking the float is a
//     cash operation, every Cash & Budgets door already gates on exactly that
//     string, and the DEFAULT MANAGER who takes the day's takings to the bank
//     holds budgets.manage and NO ledger permission at all. On the Accounting
//     hub this would be the only card in it not gated on a ledger.* permission
//     — and the reader it was built for would have to find it inside a hub
//     whose every other door is shut to them.
//   * THE BALANCES IT MOVES BETWEEN ARE ALREADY ON THIS TAB. The mockup's own
//     transfer frame opens with a "Where the money is" card — cash drawers,
//     bank, Zaad, total — which is the Cash position card three inches above
//     this button. Putting the form on the hub would have meant drawing that
//     card twice, and the second copy is the one that goes stale.
//   * A MODAL, NOT A SCREEN, so the balances stay behind it. The brief asks for
//     a modal and the reason shows here: the answer to "how much should I bank?"
//     is on the page you opened it from.
//
// The Accounting hub keeps the books. This keeps the money, which is a
// different question asked by a different person holding a different
// permission.
//
// THE SCREEN DOES NO ARITHMETIC. The four accounts, their names and their
// balances are list_transfer_accounts()'s (20261007000200), read the same way
// cash_flow()'s proof row reads them. Nothing here adds, subtracts or predicts
// a balance after the transfer: the reader presses the button and the list
// reloads from the ledger.

export function TransferFundsModal({
  shopId,
  onClose,
  onTransferred,
}: {
  shopId: string;
  onClose: () => void;
  /** Reload whatever was showing behind this — the balances have moved. */
  onTransferred: () => Promise<void> | void;
}) {
  const [accounts, setAccounts] = useState<TransferAccount[] | null>(null);
  // The read refusing is a first-class state. list_transfer_accounts is
  // security definer and RAISES without budgets.manage, so a role that loses it
  // mid-session gets a P0001 here rather than an empty list — and without this
  // the picker would sit on "Loading…" for ever, which is the Critical phase 3a
  // shipped.
  const [readError, setReadError] = useState<string | null>(null);

  const [fromCode, setFromCode] = useState<string | null>(null);
  const [toCode, setToCode] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  // The DEVICE's local day. The database resolves a null to the SHOP's day
  // (Africa/Mogadishu), and for a shop in Somalia the two are the same; where
  // they are not, the date shown is the one the person standing at the till
  // would write on the slip.
  const [on, setOn] = useState(toDateColumn(new Date()));
  const [note, setNote] = useState('');

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await listTransferAccounts(shopId);
      setAccounts(rows);
      setReadError(null);
    } catch (err) {
      setAccounts(null);
      // errorMessage and NOT `error instanceof Error`: a PostgrestError is a
      // plain object and is never an Error, so that test takes the fallback
      // every time and throws away the database's sentence. See
      // lib/error-message.ts.
      setReadError(errorMessage(err, 'Could not read this shop’s cash accounts.'));
    }
  }, [shopId]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => (cancelled ? undefined : load()))
      .catch((err) => {
        if (!cancelled) setReadError(errorMessage(err, 'Could not read this shop’s cash accounts.'));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const amountCents = toCents(amount);
  const from = accounts?.find((a) => a.code === fromCode) ?? null;
  const to = accounts?.find((a) => a.code === toCode) ?? null;
  // Every one of these is also refused by the database, in a sentence naming
  // what was asked for. This only stops a guaranteed round trip to a refusal;
  // it is not the rule, and when the two disagree the database wins and its
  // words are what gets printed.
  const canSave = Boolean(from && to && from.code !== to.code) && amountCents > 0 && !busy;

  const submit = async () => {
    if (!canSave || !from || !to) return;
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      await transferFunds({
        shopId,
        fromCode: from.code,
        toCode: to.code,
        amountCents,
        on,
        note: note.trim() || null,
      });
      setOutcome(
        `${formatAccountingCents(amountCents)} moved from ${from.name} to ${to.name}. It is in the journals as a transfer — no profit, no cost, and the same money.`
      );
      setAmount('');
      setNote('');
      await load();
      await onTransferred();
    } catch (err) {
      // THE DATABASE'S SENTENCE. Every refusal transfer_funds raises names what
      // was asked for — the two codes, the amount, the closed month — and is
      // written to be read by the person who typed it.
      setFailure(errorMessage(err, 'The database refused the transfer.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppModal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerTitles}>
              <Text style={styles.title}>Move money</Text>
              <Text style={styles.blurb}>Between your own accounts. Never a profit and never a cost.</Text>
            </View>
            <Pressable onPress={onClose} style={styles.close} role="button">
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.body}>
            {readError ? (
              // 'partial', not 'wrong': nothing here is the reader's to fix.
              <Caveat tone="partial">{readError}</Caveat>
            ) : accounts === null ? (
              <Text style={styles.quiet}>Loading…</Text>
            ) : accounts.length < 2 ? (
              <Caveat tone="context">
                A transfer needs two cash accounts to move between, and this shop’s chart has fewer than two that are
                still in use. Nothing to move money between yet.
              </Caveat>
            ) : (
              <>
                <Text style={styles.fieldLabel}>FROM</Text>
                <AccountRow accounts={accounts} selected={fromCode} disabled={toCode} onSelect={setFromCode} />

                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>TO</Text>
                <AccountRow accounts={accounts} selected={toCode} disabled={fromCode} onSelect={setToCode} />

                <View style={styles.fieldRow}>
                  <View style={styles.fieldHalf}>
                    <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>AMOUNT</Text>
                    <TextInput
                      value={amount}
                      onChangeText={setAmount}
                      placeholder="0.00"
                      placeholderTextColor={theme.bentoMuted2}
                      keyboardType="decimal-pad"
                      style={styles.input}
                    />
                  </View>
                  <View style={styles.fieldHalf}>
                    <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>DATE</Text>
                    <DateInput value={on} onChangeText={setOn} />
                  </View>
                </View>

                <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>NOTE</Text>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Evening deposit — slip no.…"
                  placeholderTextColor={theme.bentoMuted2}
                  style={styles.input}
                />

                {/* What it will do, in the ledger's own terms and in the shop's
                    own words for its accounts. Not a preview of a balance: the
                    figures under the pills above are the ledger's, and working
                    out what they would become is arithmetic this screen does
                    not do. */}
                <View style={styles.posts}>
                  <View style={styles.postsHalf}>
                    <Text style={styles.postsLabel}>Posts as</Text>
                    <Text style={styles.postsValue}>
                      {from && to ? `Dr ${to.code} ${to.name} · Cr ${from.code} ${from.name}` : 'Pick two accounts'}
                    </Text>
                  </View>
                  <View>
                    <Text style={styles.postsLabel}>Effect on profit</Text>
                    <Text style={styles.postsValue}>None</Text>
                  </View>
                </View>

                {failure ? (
                  <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => setFailure(null) }}>
                    {failure}
                  </Caveat>
                ) : null}
                {outcome ? <Caveat tone="context">{outcome}</Caveat> : null}

                <Pressable
                  onPress={submit}
                  disabled={!canSave}
                  style={[styles.button, !canSave && styles.buttonOff]}
                  role="button"
                >
                  <Text style={styles.buttonText}>{busy ? 'Moving…' : 'Record transfer'}</Text>
                </Pressable>

                <Text style={styles.footnote}>
                  A transfer entered wrongly is corrected by reversing it in the journals, not by editing it — which is
                  why there is nothing here to undo.
                </Text>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

/**
 * The four accounts as pills, each carrying its balance.
 *
 * The balance is on the pill rather than in a card above, because "does the
 * till have 3,200 in it" is a question about the account you are picking, and
 * an answer three inches away is one the reader has to hold in their head.
 *
 * `disabled` is the code chosen on the OTHER side. transfer_funds refuses a
 * transfer to the same account with a sentence naming the code; withholding
 * the tap is not the rule, it just stops a round trip whose only outcome is
 * being told what you already knew.
 */
function AccountRow({
  accounts,
  selected,
  disabled,
  onSelect,
}: {
  accounts: TransferAccount[];
  selected: string | null;
  disabled: string | null;
  onSelect: (code: string) => void;
}) {
  return (
    <View style={styles.pillRow}>
      {accounts.map((account) => {
        const off = account.code === disabled;
        const on = account.code === selected;
        return (
          <Pressable
            key={account.code}
            onPress={() => onSelect(account.code)}
            disabled={off}
            style={[styles.pill, on && styles.pillOn, off && styles.pillOff]}
            role="button"
          >
            <Text style={[styles.pillName, on && styles.pillNameOn]} numberOfLines={1}>
              {account.name}
            </Text>
            <Text style={[styles.pillBalance, on && styles.pillBalanceOn]} numberOfLines={1}>
              {formatAccountingCents(account.balanceCents)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: {
    backgroundColor: theme.bentoSurface,
    borderRadius: 26,
    padding: 22,
    width: '100%',
    maxWidth: 560,
    maxHeight: '88%',
    overflow: 'hidden',
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  headerTitles: { flexShrink: 1 },
  title: { fontSize: 18, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.4 },
  blurb: { fontSize: 12, color: theme.bentoMuted, marginTop: 3, lineHeight: 17 },
  close: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingHorizontal: 15, paddingVertical: 9 },
  closeText: { fontSize: 12, fontWeight: '800', color: theme.bentoInk2 },

  body: { flexGrow: 0 },
  quiet: { fontSize: 12.5, color: theme.bentoMuted, paddingVertical: 18, textAlign: 'center' },

  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted, marginBottom: 7 },
  fieldLabelSpaced: { marginTop: 16 },
  fieldRow: { flexDirection: 'row', gap: 10 },
  fieldHalf: { flex: 1 },
  input: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 14,
    height: 44,
    paddingHorizontal: 14,
    fontSize: 13,
    color: theme.bentoInk,
  },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  pill: { backgroundColor: theme.bentoSoft, borderRadius: 16, paddingHorizontal: 13, paddingVertical: 9, minWidth: 116 },
  pillOn: { backgroundColor: theme.bentoInk },
  pillOff: { opacity: 0.35 },
  pillName: { fontSize: 12, fontWeight: '800', color: theme.bentoInk2 },
  pillNameOn: { color: theme.bentoSurface },
  pillBalance: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 2 },
  pillBalanceOn: { color: theme.bentoSoft },

  posts: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14,
    backgroundColor: theme.bentoSoft,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 18,
  },
  postsHalf: { flexShrink: 1 },
  postsLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted },
  postsValue: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk, marginTop: 4, lineHeight: 18 },

  button: { borderRadius: 999, paddingVertical: 14, alignItems: 'center', backgroundColor: theme.bentoInk, marginTop: 16 },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  footnote: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 12, lineHeight: 16 },
});
