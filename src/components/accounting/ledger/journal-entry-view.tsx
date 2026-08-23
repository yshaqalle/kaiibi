import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { BentoCard } from '@/components/ui/bento-card';
import { Caveat } from '@/components/ui/caveat';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { listAccounts, postJournalEntry } from '@/lib/ledger';
import { toDateColumn } from '@/lib/period';
import { draftDifferenceCents, draftToLines, type DraftLine } from '@/lib/ledger-view';
import type { Account } from '@/types/models';

const theme = Colors.light;

const BLANK: DraftLine = { code: '', amountText: '', isCredit: false };

export function JournalEntryView({ onPosted, setRefresh }: { onPosted: () => void; setRefresh: RefreshSetter }) {
  const { shop } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [description, setDescription] = useState('');
  // Two rows to start, because an entry needs two. Starting at one would put
  // the reader one tap from a state the database refuses.
  const [draft, setDraft] = useState<DraftLine[]>([{ ...BLANK }, { ...BLANK, isCredit: true }]);
  const [posting, setPosting] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    setAccounts((await listAccounts(shop.id)).filter((a) => a.archivedAt === null));
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);
  useTabRefresh(setRefresh, reload);

  const differenceCents = useMemo(() => draftDifferenceCents(draft), [draft]);
  const canPost = useMemo(() => {
    if (description.trim().length === 0) return false;
    try {
      return draftToLines(draft).length >= 2 && differenceCents === 0;
    } catch {
      return false;
    }
  }, [draft, description, differenceCents]);

  const setRow = (index: number, patch: Partial<DraftLine>) =>
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const submit = async () => {
    if (!shop || !canPost || posting) return;
    setPosting(true);
    let lines: { code: string; amountCents: number }[];
    try {
      lines = draftToLines(draft);
    } catch (error) {
      setPosting(false);
      Alert.alert('Check the amounts', error instanceof Error ? error.message : 'One of the amounts cannot be read.');
      return;
    }

    // Only the call is inside the try, and the try ends the moment it resolves.
    // On the Restock branch a failed reload left a full basket under a live
    // button and pressing again committed twice.
    try {
      await postJournalEntry({
        shopId: shop.id,
        // toDateColumn, not toISOString: an entry posted in the evening west of
        // Greenwich would otherwise be dated tomorrow.
        entryDate: toDateColumn(new Date()),
        description: description.trim(),
        lines,
      });
    } catch (error) {
      setPosting(false);
      Alert.alert('Not posted', error instanceof Error ? error.message : 'The entry was refused.');
      return;
    }

    setDescription('');
    setDraft([{ ...BLANK }, { ...BLANK, isCredit: true }]);
    setPosting(false);
    onPosted();
  };

  return (
    <View style={styles.wrap}>
      <BentoCard title="The entry">
        <Text style={styles.label}>Description</Text>
        <TextInput
          style={styles.input}
          value={description}
          onChangeText={setDescription}
          placeholder="What is this entry for?"
          placeholderTextColor={theme.bentoMuted2}
        />

        <Text style={[styles.label, styles.linesLabel]}>Lines</Text>
        {draft.map((row, index) => (
          <View key={index} style={styles.row}>
            <TextInput
              style={[styles.input, styles.code]}
              value={row.code}
              onChangeText={(code) => setRow(index, { code })}
              placeholder="Code"
              placeholderTextColor={theme.bentoMuted2}
            />
            <Pressable
              style={[styles.side, row.isCredit && styles.sideOn]}
              onPress={() => setRow(index, { isCredit: !row.isCredit })}
              role="button"
              accessibilityLabel={row.isCredit ? 'Credit — tap for debit' : 'Debit — tap for credit'}
            >
              <Text style={[styles.sideText, row.isCredit && styles.sideTextOn]}>{row.isCredit ? 'Credit' : 'Debit'}</Text>
            </Pressable>
            <TextInput
              style={[styles.input, styles.amount]}
              value={row.amountText}
              // The field holds the raw string. Never normalise inside
              // onChangeText on a controlled input -- three silent 100x cost
              // bugs on the Restock branch came from exactly that.
              onChangeText={(amountText) => setRow(index, { amountText })}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={theme.bentoMuted2}
            />
          </View>
        ))}

        <Pressable onPress={() => setDraft((rows) => [...rows, { ...BLANK }])} style={styles.addRow} role="button">
          <Text style={styles.addRowText}>+ Another line</Text>
        </Pressable>

        <View style={styles.balance}>
          <Text style={styles.balanceLabel}>Difference</Text>
          <Text style={[styles.balanceValue, { color: differenceCents === 0 ? theme.bentoProfit : theme.bentoLoss }]}>
            {differenceCents === 0 ? '✓ balanced' : formatCents(differenceCents)}
          </Text>
        </View>

        <Pressable
          onPress={submit}
          disabled={!canPost || posting}
          style={[styles.post, (!canPost || posting) && styles.postOff]}
          role="button"
        >
          <Text style={styles.postText}>{posting ? 'Posting…' : 'Post entry'}</Text>
        </Pressable>
      </BentoCard>

      <Caveat tone="wrong" action={{ label: 'See the journals', onPress: onPosted }}>
        Posting is final. A posted entry cannot be edited or deleted — if it is wrong, you reverse it, which leaves both the
        mistake and the correction on the record.
      </Caveat>
      <Caveat tone="context">
        {`${accounts.length} accounts are available. Type the code — 5100 for shrinkage, 1200 for inventory, 1000 for cash.`}
      </Caveat>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  label: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase', color: theme.bentoMuted, marginBottom: 6 },
  linesLabel: { marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontSize: 13.5,
    color: theme.bentoInk,
    backgroundColor: theme.bentoSurface,
  },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8, alignItems: 'center' },
  code: { width: 88 },
  amount: { flex: 1, textAlign: 'right' },
  side: { borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 9 },
  sideOn: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  sideText: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  sideTextOn: { color: theme.bentoSurface },
  addRow: { alignSelf: 'flex-start', paddingVertical: 8 },
  addRowText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoMuted },
  balance: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: theme.bentoSoft,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 13,
    marginTop: 10,
  },
  balanceLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase', color: theme.bentoMuted },
  balanceValue: { fontSize: 17, fontWeight: '800' },
  post: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  postOff: { opacity: 0.4 },
  postText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
});
