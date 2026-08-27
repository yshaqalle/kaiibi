import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { DateInput } from '@/components/date-input';
import { type LedgerView } from '@/components/accounting/ledger/ledger-hub';
import { useTabRefresh, type RefreshSetter } from '@/components/accounting/use-header-actions';
import { StatTile } from '@/components/stat-tile';
import { BentoCard } from '@/components/ui/bento-card';
import { BentoCell, BentoGrid } from '@/components/ui/bento';
import { Caveat } from '@/components/ui/caveat';
import { DataTable, NameCell, ValueCell, type Column } from '@/components/ui/data-table';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { formatAccountingCents, formatCompactCents, toCents } from '@/lib/currency';
import { errorMessage } from '@/lib/error-message';
import { listAccounts } from '@/lib/ledger';
import { toDateColumn } from '@/lib/period';
import {
  createFixedAsset,
  deleteFixedAsset,
  disposeFixedAsset,
  getFixedAssetSummary,
  listFixedAssets,
  runDepreciation,
  type FixedAsset,
  type FixedAssetSummary,
} from '@/lib/fixed-assets';
import type { Account } from '@/types/models';

const theme = Colors.light;

// The fixed-asset register: what the shop owns that wears out, at cost, less
// what has been written off it.
//
// THE SCREEN DOES NO ARITHMETIC. Cost is a column; accumulated depreciation,
// net book value and all four figures across the top come from
// list_fixed_assets() and fixed_asset_summary() (20261007000000). Nothing here
// sums a column, subtracts a total or predicts next month's charge -- a screen
// that adds its own rows up is a second implementation of the balance sheet,
// and this project has paid for that shape before.
//
// A DISPOSED ASSET HAS NO BOOK VALUE, and the em dash in that cell is the
// database's NULL rather than this screen's opinion. Its cost and its
// depreciation are still shown, quietly, because both are facts.
//
// EVERY FORM IS A STATE OF A CARD, NOT A DIALOG -- the same three reasons
// backfill-view.tsx and close-period-view.tsx give, and one of them is
// load-bearing here: this view renders inside the Accounting tab, so a sheet
// opened from it is a second modal and iOS silently drops it, which reads as a
// dead button.
//
// AND IT PRINTS THE DATABASE'S SENTENCE. create_fixed_asset,
// dispose_fixed_asset, delete_fixed_asset and run_depreciation each refuse with
// a sentence naming what was asked for -- the account that is not in 1500-1599,
// the disposal dated before the acquisition, the asset that has already been
// depreciated. errorMessage() and never `instanceof Error`: a PostgrestError is
// a plain object, so that test takes the fallback every time.

/** The 15xx accounts an asset may sit in — the range, less the contra account. */
function assetAccounts(accounts: Account[]): Account[] {
  return accounts.filter(
    (a) => a.archivedAt === null && a.code >= '1500' && a.code <= '1599' && a.code !== '1590'
  );
}

/** The four cash accounts create_fixed_asset and dispose_fixed_asset accept. */
const CASH_CODES = ['1000', '1010', '1020', '1021'];
function cashAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.archivedAt === null && CASH_CODES.includes(a.code));
}

export function FixedAssetsView({
  setRefresh,
  onOpenView,
}: {
  setRefresh: RefreshSetter;
  onOpenView: (view: LedgerView) => void;
}) {
  const { shop, can } = useAuth();
  // The hub hides this card without ledger.view, but `view` is a URL parameter
  // and a role can change while a session is open -- which is exactly the
  // Critical phase 3a shipped. This is the screen's own answer, not the hub's.
  const canPost = can('ledger.post');

  const [assets, setAssets] = useState<FixedAsset[] | null>(null);
  const [summary, setSummary] = useState<FixedAssetSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // list_fixed_assets() is security definer and RAISES without ledger.view,
  // where a table read under RLS would return nothing. Uncaught, that leaves the
  // screen on "Loading…" for ever.
  const [readError, setReadError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [disposing, setDisposing] = useState<FixedAsset | null>(null);
  const [removing, setRemoving] = useState<FixedAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shop) return;
    // The register first and alone: it is the call that can refuse, and
    // everything else is decoration around it.
    let rows: FixedAsset[];
    try {
      rows = await listFixedAssets(shop.id);
    } catch (error) {
      setAssets(null);
      setSummary(null);
      setReadError(errorMessage(error, "Could not read this shop's asset register."));
      return;
    }
    setReadError(null);
    setAssets(rows);

    try {
      setSummary(await getFixedAssetSummary(shop.id));
    } catch {
      // The totals going missing costs the strip and nothing else. They are the
      // same figures the rows carry, read once by the database.
      setSummary(null);
    }
    try {
      setAccounts(await listAccounts(shop.id));
    } catch {
      // The chart is only needed by the two forms, which say so themselves when
      // it is empty rather than taking the table down with them.
      setAccounts([]);
    }
  }, [shop]);

  // The mounting fetch. use-refresh-on-focus deliberately does not fire on the
  // focus that mounts a screen. Reached through a resolved promise rather than
  // by calling load() in the effect body, which is a lint error
  // (react-hooks/set-state-in-effect) -- the shape close-period-view takes.
  useEffect(() => {
    if (!shop) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => (cancelled ? undefined : load()))
      .catch((error) => {
        if (!cancelled) setReadError(errorMessage(error, "Could not read this shop's asset register."));
      });
    return () => {
      cancelled = true;
    };
  }, [shop, load]);
  useRefreshOnFocus(load);
  useTabRefresh(setRefresh, load);

  const assetCodes = useMemo(() => assetAccounts(accounts), [accounts]);
  const cashCodes = useMemo(() => cashAccounts(accounts), [accounts]);

  const runAction = async (action: () => Promise<string>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      setOutcome(await action());
    } catch (error) {
      setFailure(errorMessage(error, fallback));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const depreciate = () =>
    runAction(async () => {
      if (!shop) return '';
      const entries = await runDepreciation(shop.id);
      // The COUNT the function returned, not a count worked out here. Zero is
      // the ordinary answer for a shop that already ran it this month, and it
      // is a success rather than a failure.
      return entries === 0
        ? 'Nothing was due. Every complete month has already been depreciated, so nothing was posted.'
        : `${entries} monthly depreciation ${entries === 1 ? 'entry is' : 'entries are'} in the journals — Dr 6800 Depreciation, Cr 1590 Accumulated Depreciation.`;
    }, 'The database refused the depreciation run.');

  const columns: Column<FixedAsset>[] = [
    {
      key: 'asset',
      header: 'Asset',
      render: (row) => (
        <NameCell
          title={row.name}
          meta={
            row.disposedOn
              ? `${row.accountName ?? row.accountCode} · sold ${row.disposedOn}`
              : row.acquisitionStatus === 'posted'
                ? `${row.accountName ?? row.accountCode} · ${row.accountCode}`
                : `${row.accountName ?? row.accountCode} · purchase voided`
          }
        />
      ),
    },
    { key: 'bought', header: 'Bought', width: 116, render: (row) => <ValueCell value={row.acquiredOn} tone="muted" /> },
    {
      key: 'method',
      header: 'Method',
      width: 168,
      render: (row) => (
        <ValueCell
          value={
            row.disposedOn
              ? 'Disposed'
              : `Straight line · ${row.lifeMonths} months`
          }
          tone="muted"
        />
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      width: 110,
      numeric: true,
      render: (row) => <ValueCell value={formatAccountingCents(row.costCents)} tone={row.disposedOn ? 'muted' : 'default'} />,
    },
    {
      key: 'depreciated',
      header: 'Depreciated',
      width: 118,
      numeric: true,
      render: (row) => (
        <ValueCell
          value={formatAccountingCents(row.accumulatedCents)}
          tone={row.disposedOn ? 'muted' : row.accumulatedCents > 0 ? 'danger' : 'muted'}
        />
      ),
    },
    {
      key: 'book',
      header: 'Book value',
      width: 118,
      numeric: true,
      // THE DATABASE'S NULL, not a zero this screen decided on. A sold asset is
      // off the balance sheet, so it has no book value.
      render: (row) => (
        <ValueCell
          value={row.netBookCents === null ? '—' : formatAccountingCents(row.netBookCents)}
          tone={row.netBookCents === null ? 'muted' : 'default'}
          strong={row.netBookCents !== null}
        />
      ),
    },
    {
      key: 'action',
      header: '',
      width: 132,
      render: (row) =>
        row.disposedOn || !canPost ? (
          <ValueCell value={row.disposedOn ? 'History' : '—'} tone="muted" />
        ) : (
          <View style={styles.rowActions}>
            <Pressable
              onPress={() => {
                setDisposing(row);
                setRemoving(null);
                setFailure(null);
              }}
              role="button"
              style={styles.rowAction}
            >
              <Text style={styles.rowActionText}>Sell</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setRemoving(row);
                setDisposing(null);
                setFailure(null);
              }}
              role="button"
              style={styles.rowAction}
            >
              <Text style={styles.rowActionText}>Remove</Text>
            </Pressable>
          </View>
        ),
    },
  ];

  return (
    <View style={styles.wrap}>
      {readError ? (
        // 'partial' rather than 'wrong': nothing here is the reader's to fix,
        // and a 'wrong' with no action trains people to skip the whole family.
        <BentoCard title="Fixed assets">
          <Caveat tone="partial">{readError}</Caveat>
        </BentoCard>
      ) : null}

      {!readError && !canPost ? (
        <BentoCard title="Fixed assets">
          <Caveat tone="partial">
            Recording equipment, selling it and running depreciation all need permission to write entries to the ledger,
            which your role does not carry. You can still read the register below. Ask an owner.
          </Caveat>
        </BentoCard>
      ) : null}

      {summary ? (
        <BentoGrid>
          <BentoCell span={12}>
            <BentoCard title="What the shop owns" scope="As of today">
              <View style={styles.tiles}>
                <StatTile
                  value={formatCompactCents(summary.costCents)}
                  label="Assets at cost"
                  hint={`${summary.liveCount} ${summary.liveCount === 1 ? 'item' : 'items'}`}
                  variant="bento"
                />
                <StatTile
                  value={formatCompactCents(summary.accumulatedCents)}
                  label="Depreciated so far"
                  hint="written off since purchase"
                  variant="bento"
                />
                <StatTile
                  value={formatCompactCents(summary.netBookCents)}
                  label="Book value"
                  hint="on the balance sheet"
                  variant="bento"
                />
                <StatTile
                  value={summary.lastChargeMonth ? formatCompactCents(summary.lastChargeCents) : 'None yet'}
                  label="Last charge posted"
                  // The month the charge BELONGS to, which is not the date its
                  // entry carries once a closed month has redirected it.
                  hint={summary.lastChargeMonth ? `for ${summary.lastChargeMonth.slice(0, 7)}` : 'run depreciation to start'}
                  variant="bento"
                />
              </View>

              {/* THE ONE WAY THIS REGISTER AND THE BALANCE SHEET CAN HONESTLY
                  DISAGREE, and it is named rather than absorbed. Voiding an
                  asset's purchase entry through the general ledger takes its
                  cost out of 1500-1599 and leaves the register row standing --
                  reverse_journal_entry is a generic door that knows nothing
                  about this table. */}
              {summary.voidedCount > 0 ? (
                <Caveat tone="wrong" action={{ label: 'Find it in the journals', onPress: () => onOpenView('journals') }}>
                  {`${summary.voidedCount} ${summary.voidedCount === 1 ? 'asset has' : 'assets have'} had ${summary.voidedCount === 1 ? 'its' : 'their'} purchase entry voided in the ledger, ${formatAccountingCents(summary.voidedCostCents)} at cost. ${summary.voidedCount === 1 ? 'It is' : 'They are'} still in this register and no longer on the balance sheet, so Book value above is that much higher than the statement. Either re-record the purchase or remove the row.`}
                </Caveat>
              ) : null}
            </BentoCard>
          </BentoCell>
        </BentoGrid>
      ) : null}

      {failure ? (
        <Caveat tone="wrong" action={{ label: 'Try again', onPress: () => { setFailure(null); load(); } }}>
          {failure}
        </Caveat>
      ) : null}
      {outcome ? (
        <Caveat tone="context" action={{ label: 'See it in Journals', onPress: () => onOpenView('journals') }}>
          {outcome}
        </Caveat>
      ) : null}

      {/* Out of the grid entirely: a register is read down a column, so it takes
          the full width and manages its own gutters. DataTable already scrolls
          sideways inside the card. */}
      <BentoCard
        title="Asset register"
        scope={summary ? undefined : 'As of today'}
        bodyStyle={styles.tableBody}
        actions={
          canPost ? (
            <View style={styles.headActions}>
              <Pressable onPress={depreciate} disabled={busy} style={[styles.headButton, busy && styles.buttonOff]} role="button">
                <Text style={styles.headButtonText}>{busy ? 'Working…' : 'Run depreciation'}</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setAdding((open) => !open);
                  setFailure(null);
                }}
                style={[styles.headButton, styles.headButtonSolid]}
                role="button"
              >
                <Text style={[styles.headButtonText, styles.headButtonTextSolid]}>+ Add asset</Text>
              </Pressable>
            </View>
          ) : undefined
        }
      >
        <DataTable
          columns={columns}
          rows={assets ?? []}
          keyExtractor={(row) => row.id}
          minWidth={880}
          emptyLabel={
            readError
              ? 'The register could not be read.'
              : assets === null
                ? 'Loading…'
                : 'Nothing in the register yet. A fridge, a generator or a set of shelves belongs here rather than in Expenses — it is worth something next year.'
          }
        />
      </BentoCard>

      {adding && shop ? (
        <AddAssetCard
          assetCodes={assetCodes}
          cashCodes={cashCodes}
          busy={busy}
          onCancel={() => setAdding(false)}
          onCreate={async (input) => {
            await runAction(async () => {
              await createFixedAsset(shop.id, input);
              setAdding(false);
              return `${input.name} is in the register at ${formatAccountingCents(input.costCents)}, and the purchase is in the journals. It will depreciate over ${input.lifeMonths} months once you run depreciation.`;
            }, 'The database refused this asset.');
          }}
        />
      ) : null}

      {disposing && !disposing.disposedOn ? (
        <DisposeAssetCard
          asset={disposing}
          cashCodes={cashCodes}
          busy={busy}
          onCancel={() => setDisposing(null)}
          onDispose={async (on, proceedsCents, intoCode) => {
            const asset = disposing;
            await runAction(async () => {
              await disposeFixedAsset(asset.id, on, proceedsCents, intoCode);
              setDisposing(null);
              // NO GAIN OR LOSS QUOTED HERE. It is cost less accumulated
              // depreciation less proceeds, which is arithmetic, and the
              // function that performed it wrote it into 6900 with a memo
              // naming the asset. Saying it a second time here is how the two
              // come to disagree.
              return `${asset.name} is out of the register. Its cost and its depreciation are off the balance sheet, and the difference between its book value and what it fetched is in 6900 Other.`;
            }, 'The database refused the disposal.');
          }}
        />
      ) : null}

      {removing && !removing.disposedOn ? (
        <BentoCard title={`Remove ${removing.name}?`}>
          <Text style={styles.body}>
            This is for something entered <Text style={styles.strong}>in error</Text>, not for something the shop no
            longer has. The register row goes and the purchase entry is{' '}
            <Text style={styles.strong}>reversed, never deleted</Text> — both halves stay in the journals. An asset that
            has already been depreciated or sold cannot be removed this way, and the database will say so.
          </Text>
          <View style={styles.buttons}>
            <Pressable onPress={() => setRemoving(null)} style={[styles.button, styles.buttonGhost]} role="button">
              <Text style={styles.buttonGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                const asset = removing;
                await runAction(async () => {
                  await deleteFixedAsset(asset.id);
                  setRemoving(null);
                  return `${asset.name} is out of the register and its purchase entry is reversed.`;
                }, 'The database refused the removal.');
              }}
              disabled={busy}
              style={[styles.button, styles.buttonGo, busy && styles.buttonOff]}
              role="button"
            >
              <Text style={styles.buttonGoText}>{busy ? 'Removing…' : `Remove ${removing.name}`}</Text>
            </Pressable>
          </View>
        </BentoCard>
      ) : null}

      <Caveat tone="context">
        Cost is never edited down. An asset keeps what you paid for it for as long as you own it, and the wear
        accumulates in a separate account that offsets it — which is what lets the balance sheet show both what you paid
        and what it is worth now.
      </Caveat>
    </View>
  );
}

/**
 * Recording a purchase.
 *
 * ON CREDIT IS THE FIRST OPTION AND THE DEFAULT, matching
 * create_fixed_asset's own default and for its reason: an omitted payment must
 * not invent one. A shop that paid cash says which till.
 */
function AddAssetCard({
  assetCodes,
  cashCodes,
  busy,
  onCancel,
  onCreate,
}: {
  assetCodes: Account[];
  cashCodes: Account[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    costCents: number;
    acquiredOn: string;
    lifeMonths: number;
    paidFromCode: string | null;
    accountCode: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [cost, setCost] = useState('');
  const [acquiredOn, setAcquiredOn] = useState(toDateColumn(new Date()));
  const [life, setLife] = useState('36');
  const [accountCode, setAccountCode] = useState(assetCodes[0]?.code ?? '1500');
  const [paidFromCode, setPaidFromCode] = useState<string | null>(null);

  const costCents = toCents(cost);
  const lifeMonths = Number(life);
  const canSave =
    name.trim().length > 0 && costCents > 0 && Number.isFinite(lifeMonths) && lifeMonths >= 1 && !busy;

  return (
    <BentoCard title="Add an asset" scope="Posts to the ledger">
      {assetCodes.length === 0 ? (
        <Caveat tone="partial">
          This shop&rsquo;s chart has no equipment account in the 1500–1599 range for an asset to sit in, or it could not
          be read. Add one in the Chart of Accounts first.
        </Caveat>
      ) : (
        <>
          <Text style={styles.label}>WHAT IS IT</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Chest freezer — Haier 500L"
            placeholderTextColor={theme.bentoMuted2}
            style={styles.input}
          />

          <View style={styles.fieldRow}>
            <View style={styles.fieldThird}>
              <Text style={[styles.label, styles.labelSpaced]}>COST</Text>
              <TextInput
                value={cost}
                onChangeText={setCost}
                placeholder="0.00"
                placeholderTextColor={theme.bentoMuted2}
                keyboardType="decimal-pad"
                style={styles.input}
              />
            </View>
            <View style={styles.fieldThird}>
              <Text style={[styles.label, styles.labelSpaced]}>BOUGHT ON</Text>
              <DateInput value={acquiredOn} onChangeText={setAcquiredOn} />
            </View>
            <View style={styles.fieldThird}>
              {/* MONTHS, not years, because that is the unit the charge is in
                  and the unit the database stores. A shop buying a phone
                  writes 24, and nobody has to multiply. */}
              <Text style={[styles.label, styles.labelSpaced]}>USEFUL LIFE (MONTHS)</Text>
              <TextInput
                value={life}
                onChangeText={setLife}
                placeholder="36"
                placeholderTextColor={theme.bentoMuted2}
                keyboardType="number-pad"
                style={styles.input}
              />
            </View>
          </View>

          <Text style={[styles.label, styles.labelSpaced]}>HELD IN</Text>
          <View style={styles.pillRow}>
            {assetCodes.map((account) => (
              <Pressable
                key={account.code}
                onPress={() => setAccountCode(account.code)}
                style={[styles.pill, accountCode === account.code && styles.pillOn]}
                role="button"
              >
                <Text style={[styles.pillText, accountCode === account.code && styles.pillTextOn]}>
                  {account.code} {account.name}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.label, styles.labelSpaced]}>PAID FROM</Text>
          <View style={styles.pillRow}>
            <Pressable
              onPress={() => setPaidFromCode(null)}
              style={[styles.pill, paidFromCode === null && styles.pillOn]}
              role="button"
            >
              <Text style={[styles.pillText, paidFromCode === null && styles.pillTextOn]}>On credit</Text>
            </Pressable>
            {cashCodes.map((account) => (
              <Pressable
                key={account.code}
                onPress={() => setPaidFromCode(account.code)}
                style={[styles.pill, paidFromCode === account.code && styles.pillOn]}
                role="button"
              >
                <Text style={[styles.pillText, paidFromCode === account.code && styles.pillTextOn]}>{account.name}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.footnote}>
            {paidFromCode === null
              ? 'On credit owes the supplier for it — Cr 2000 Accounts Payable, and no money leaves a till that never opened.'
              : 'Paid now takes the money out of that account today.'}
          </Text>

          <View style={styles.buttons}>
            <Pressable onPress={onCancel} style={[styles.button, styles.buttonGhost]} role="button">
              <Text style={styles.buttonGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                onCreate({
                  name: name.trim(),
                  costCents,
                  acquiredOn,
                  lifeMonths: Math.round(lifeMonths),
                  paidFromCode,
                  accountCode,
                })
              }
              disabled={!canSave}
              style={[styles.button, styles.buttonGo, !canSave && styles.buttonOff]}
              role="button"
            >
              <Text style={styles.buttonGoText}>{busy ? 'Recording…' : 'Record it'}</Text>
            </Pressable>
          </View>
        </>
      )}
    </BentoCard>
  );
}

/**
 * Selling one.
 *
 * No gain or loss is previewed. It is cost less accumulated depreciation less
 * proceeds, and working it out here would be this screen doing the arithmetic
 * dispose_fixed_asset does — two derivations of one figure, which agree until
 * they don't. The book value being removed IS shown, because it is a column the
 * register already returned.
 */
function DisposeAssetCard({
  asset,
  cashCodes,
  busy,
  onCancel,
  onDispose,
}: {
  asset: FixedAsset;
  cashCodes: Account[];
  busy: boolean;
  onCancel: () => void;
  onDispose: (on: string, proceedsCents: number, intoCode: string) => Promise<void>;
}) {
  const [on, setOn] = useState(toDateColumn(new Date()));
  const [proceeds, setProceeds] = useState('');
  const [intoCode, setIntoCode] = useState(cashCodes[0]?.code ?? '1000');
  const proceedsCents = toCents(proceeds);

  return (
    <BentoCard title={`Sell ${asset.name}`} scope="Posts to the ledger">
      <Text style={styles.body}>
        Its book value today is{' '}
        <Text style={styles.strong}>
          {asset.netBookCents === null ? '—' : formatAccountingCents(asset.netBookCents)}
        </Text>{' '}
        — {formatAccountingCents(asset.costCents)} at cost, less {formatAccountingCents(asset.accumulatedCents)}{' '}
        written off. Whatever it fetches above or below that is a gain or a loss, and lands in 6900 Other with the
        asset named in the memo.
      </Text>

      <View style={styles.fieldRow}>
        <View style={styles.fieldHalf}>
          <Text style={[styles.label, styles.labelSpaced]}>SOLD ON</Text>
          <DateInput value={on} onChangeText={setOn} />
        </View>
        <View style={styles.fieldHalf}>
          <Text style={[styles.label, styles.labelSpaced]}>WHAT IT FETCHED</Text>
          <TextInput
            value={proceeds}
            onChangeText={setProceeds}
            placeholder="0.00"
            placeholderTextColor={theme.bentoMuted2}
            keyboardType="decimal-pad"
            style={styles.input}
          />
        </View>
      </View>

      {proceedsCents > 0 ? (
        <>
          <Text style={[styles.label, styles.labelSpaced]}>MONEY ARRIVED IN</Text>
          <View style={styles.pillRow}>
            {cashCodes.map((account) => (
              <Pressable
                key={account.code}
                onPress={() => setIntoCode(account.code)}
                style={[styles.pill, intoCode === account.code && styles.pillOn]}
                role="button"
              >
                <Text style={[styles.pillText, intoCode === account.code && styles.pillTextOn]}>{account.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <Text style={styles.footnote}>
          Leave it empty if the asset was scrapped or given away. Its whole remaining book value becomes a loss.
        </Text>
      )}

      <View style={styles.buttons}>
        <Pressable onPress={onCancel} style={[styles.button, styles.buttonGhost]} role="button">
          <Text style={styles.buttonGhostText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => onDispose(on, proceedsCents, intoCode)}
          disabled={busy}
          style={[styles.button, styles.buttonGo, busy && styles.buttonOff]}
          role="button"
        >
          <Text style={styles.buttonGoText}>{busy ? 'Recording…' : 'Record the sale'}</Text>
        </Pressable>
      </View>
    </BentoCard>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tableBody: { paddingHorizontal: 10 },

  headActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headButton: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: theme.bentoSoft },
  headButtonSolid: { backgroundColor: theme.bentoInk },
  headButtonText: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk2 },
  headButtonTextSolid: { color: theme.bentoSurface },

  rowActions: { flexDirection: 'row', gap: 6, justifyContent: 'flex-end' },
  rowAction: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: theme.bentoSoft },
  rowActionText: { fontSize: 11, fontWeight: '800', color: theme.bentoInk2 },

  body: { fontSize: 12.5, lineHeight: 20, color: theme.bentoMuted },
  strong: { fontWeight: '800', color: theme.bentoInk },

  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: theme.bentoMuted, marginBottom: 6 },
  labelSpaced: { marginTop: 14 },
  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  fieldHalf: { flex: 1, minWidth: 150 },
  fieldThird: { flex: 1, minWidth: 130 },
  input: {
    backgroundColor: theme.bentoSoft,
    borderRadius: 14,
    height: 44,
    paddingHorizontal: 14,
    fontSize: 13,
    color: theme.bentoInk,
  },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: theme.bentoSoft },
  pillOn: { backgroundColor: theme.bentoInk },
  pillText: { fontSize: 11.5, fontWeight: '700', color: theme.bentoInk2 },
  pillTextOn: { color: theme.bentoSurface },

  footnote: { fontSize: 11.5, color: theme.bentoMuted2, marginTop: 8, lineHeight: 16 },

  buttons: { flexDirection: 'row', gap: 9, marginTop: 16 },
  button: { borderRadius: 999, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center' },
  buttonGo: { backgroundColor: theme.bentoInk, flex: 1 },
  buttonGoText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  buttonGhost: { backgroundColor: theme.bentoSoft },
  buttonGhostText: { color: theme.bentoInk2, fontSize: 13.5, fontWeight: '800' },
  buttonOff: { opacity: 0.4 },
});
