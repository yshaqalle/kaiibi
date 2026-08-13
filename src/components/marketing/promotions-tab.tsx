import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useDetailSelection, useHeaderActions, type DetailSelectionSetter, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { CategoryChip } from '@/components/category-chip';
import { DateInput } from '@/components/date-input';
import { PosterSheet } from '@/components/marketing/poster-sheet';
import { StatTile } from '@/components/stat-tile';
import { TwoPaneListDetail } from '@/components/two-pane-list-detail';
import { BentoCard } from '@/components/ui/bento-card';
import { GlanceStrip } from '@/components/ui/glance-strip';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { listBrands } from '@/lib/brands';
import { listCategories } from '@/lib/categories';
import { createPromotion, deletePromotion, discountLabel, listPromotions, scopeLabel, updatePromotion, type NewPromotionInput } from '@/lib/promotions';
import { endDateInputToInstant, instantToEndDateInput, instantToStartDateInput, startDateInputToInstant } from '@/lib/promotion-dates';
import type { Promotion } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet. Matches
// people.tsx: People is a bento screen (see two-pane-list-detail.tsx), not the
// cream one — this tab reads theme.bento* the same way CustomersTab does.
const theme = Colors.light;

// Supabase rpc()/query errors (e.g. the not-authorized raise, a constraint
// violation, an RLS denial) are plain {code, details, hint, message} objects,
// never instanceof Error -- checking that first always falls through to the
// generic fallback and hides the real reason. See pos.tsx's
// extractErrorMessage for the same fix applied to checkout.
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return fallback;
}

// 'live'/'scheduled'/'expired'/'paused' -- deliberately the same three clauses
// as isPromotionLive (lib/discounts.ts), just not collapsed to a boolean, so a
// row can say WHY something isn't applying rather than only that it isn't.
// A manual-only offer is inside its window and switched on, yet never comes
// off a sale by itself -- so calling it "Live" beside a tile that says
// "applying at checkout" states the opposite of what happens at the till. It
// gets its own status rather than a footnote, because the difference is the
// whole point of the auto_apply flag.
type PromoStatus = 'live' | 'manual' | 'scheduled' | 'expired' | 'paused';

function promoStatus(p: Promotion, now: number): PromoStatus {
  if (!p.active) return 'paused';
  if (p.startsAt && Date.parse(p.startsAt) > now) return 'scheduled';
  if (p.endsAt && Date.parse(p.endsAt) <= now) return 'expired';
  return p.autoApply ? 'live' : 'manual';
}

const STATUS_LABEL: Record<PromoStatus, string> = {
  live: 'Live',
  manual: 'When picked',
  scheduled: 'Scheduled',
  expired: 'Expired',
  paused: 'Paused',
};

const STATUS_TONE: Record<PromoStatus, 'default' | 'success' | 'warning'> = {
  live: 'success',
  manual: 'warning',
  scheduled: 'warning',
  expired: 'default',
  paused: 'default',
};

export function PromotionsTab({
  compact,
  setHeaderActions,
  setDetailSelected,
}: {
  compact: boolean;
  setHeaderActions: HeaderActionsSetter;
  setDetailSelected: DetailSelectionSetter;
}) {
  const { shop } = useAuth();
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  // Tracks the FIRST fetch, not every fetch -- see the identical comment on
  // CustomersTab (people.tsx). Keeps rows mounted across a reload so the list
  // doesn't collapse and lose scroll position.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which promotion the form pane is showing. null while creating.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Whether the detail pane (the form) is open at all -- distinct from
  // editingId, since "New sale" opens the same pane with editingId still null.
  const [formOpen, setFormOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Which promotion the poster sheet is open for -- a full row, not just an
  // id, so PosterSheet has everything posterCopyFor needs without a second
  // lookup. Independent of `editingId`/`formOpen`: opening a poster does not
  // close or reset the edit form underneath it.
  const [posterPromotion, setPosterPromotion] = useState<Promotion | null>(null);
  // Set once deletePromotion resolves, replacing the delete confirm with its
  // outcome -- there is no toast/snackbar surface anywhere in this app (see
  // src/lib/confirm.ts: both helpers there are pre-action confirms, not
  // post-write notices), so the distinction between the two outcomes has to
  // live in this same on-form slot rather than inventing one.
  const [deleteResult, setDeleteResult] = useState<'deleted' | 'archived' | null>(null);

  const [name, setName] = useState('');
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [scope, setScope] = useState<'store' | 'brand' | 'category'>('store');
  const [scopeValue, setScopeValue] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  // Both ends optional, and each empty state says what it means rather than
  // leaving a blank field to guess at -- see the hint text under each
  // DateInput below. Held as string | null to match NewPromotionInput
  // directly; DateInput itself only knows plain strings (see the bridging in
  // the render below).
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [endsAt, setEndsAt] = useState<string | null>(null);
  const [autoApply, setAutoApply] = useState(true);

  const [saving, setSaving] = useState(false);

  // A snapshot, not a clock -- taken alongside each reload (mount, refocus,
  // pull-to-refresh) rather than read live during render, which would call an
  // impure function from a component body. Same pattern as `loadedAt` in
  // app/platform/index.tsx. Good enough for an informational stat/status: this
  // tab isn't a countdown, and a promotion's window crossing a boundary while
  // the tab sits open and unrefreshed is not a case worth a ticking clock for.
  const [now, setNow] = useState(() => Date.now());

  useDetailSelection(setDetailSelected, formOpen);

  const reload = useCallback(async () => {
    if (!shop) return;
    setError(null);
    try {
      const [promoList, brandRows, categoryRows] = await Promise.all([
        listPromotions(shop.id),
        listBrands(shop.id),
        listCategories(shop.id),
      ]);
      setPromotions(promoList);
      setBrands(brandRows.map((b) => b.name));
      setCategories(categoryRows.map((c) => c.name));
      setNow(Date.now());
    } catch (err) {
      setError(extractErrorMessage(err, 'Something went wrong.'));
    } finally {
      setLoaded(true);
    }
  }, [shop]);

  useEffect(() => {
    reload();
  }, [reload]);
  useRefreshOnFocus(reload);
  const pullToRefresh = usePullToRefresh(reload);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDiscountType('percentage');
    setDiscountValue('');
    setScope('store');
    setScopeValue(null);
    setActive(true);
    setStartsAt(null);
    setEndsAt(null);
    setAutoApply(true);
    setConfirmingDelete(false);
    setDeleteResult(null);
  };

  const startCreate = () => {
    resetForm();
    setFormOpen(true);
  };

  const startEdit = (promo: Promotion) => {
    setEditingId(promo.id);
    setName(promo.name);
    setDiscountType(promo.discountType);
    setDiscountValue(promo.discountType === 'fixed' ? (promo.discountValue / 100).toFixed(2) : String(promo.discountValue));
    setScope(promo.scope);
    setScopeValue(promo.scopeValue);
    setActive(promo.active);
    // PostgREST returns a full timestamp ("2026-08-15T00:00:00+00:00"), but
    // DateInput expects a plain YYYY-MM-DD: on web an <input type="date">
    // just renders blank for anything else, silently discarding the saved
    // date and, since the state is still truthy, suppressing the "Running
    // now"/"Until I switch it off" hint too. Slicing the ISO string to its
    // first 10 characters is the WRONG conversion -- see promotion-dates.ts's
    // header comment -- these route through its local-time functions
    // instead, which is also what un-shifts the stored end instant back to
    // the inclusive day the owner actually picked.
    setStartsAt(promo.startsAt ? instantToStartDateInput(promo.startsAt) : null);
    setEndsAt(promo.endsAt ? instantToEndDateInput(promo.endsAt) : null);
    setAutoApply(promo.autoApply);
    setConfirmingDelete(false);
    setDeleteResult(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    resetForm();
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setSaving(true);
    try {
      await action();
    } catch (err) {
      setError(extractErrorMessage(err, 'Something went wrong.'));
    } finally {
      setSaving(false);
    }
  };

  const canSave = name.trim().length > 0 && Number(discountValue) > 0 && (scope === 'store' || Boolean(scopeValue));

  // The saved row, for the Poster action below -- and for isFormDirty, which
  // asks whether the form still matches it. A poster must never advertise a
  // discount the till won't give, so PosterSheet is always handed this saved
  // promotion rather than the live form (right, and unchanged); what was
  // missing is telling the owner when those two have quietly drifted apart,
  // e.g. 20% edited to 30% and Poster tapped before Save. Reconstructed with
  // the exact same field-by-field transforms startEdit uses to populate the
  // form from a promotion, so this compares like with like.
  const editingPromotion = editingId ? (promotions.find((p) => p.id === editingId) ?? null) : null;
  const isFormDirty =
    editingPromotion !== null &&
    (name !== editingPromotion.name ||
      discountType !== editingPromotion.discountType ||
      discountValue !==
        (editingPromotion.discountType === 'fixed' ? (editingPromotion.discountValue / 100).toFixed(2) : String(editingPromotion.discountValue)) ||
      scope !== editingPromotion.scope ||
      scopeValue !== editingPromotion.scopeValue ||
      active !== editingPromotion.active ||
      startsAt !== (editingPromotion.startsAt ? instantToStartDateInput(editingPromotion.startsAt) : null) ||
      endsAt !== (editingPromotion.endsAt ? instantToEndDateInput(editingPromotion.endsAt) : null) ||
      autoApply !== editingPromotion.autoApply);

  const submit = () => {
    if (!shop) return;
    const trimmedName = name.trim();
    const num = Number(discountValue);
    if (!trimmedName || !num || num <= 0) return;
    if (scope !== 'store' && !scopeValue) return;
    const input: NewPromotionInput = {
      name: trimmedName,
      discountType,
      discountValue: discountType === 'fixed' ? Math.round(num * 100) : Math.min(num, 100),
      scope,
      scopeValue: scope === 'store' ? null : scopeValue,
      active,
      // The picker deals in whole local days; the column is a timestamptz.
      // See promotion-dates.ts's header comment for why the end date shifts
      // forward a day here (stored exclusive) while the start date doesn't.
      startsAt: startsAt ? startDateInputToInstant(startsAt) : null,
      endsAt: endsAt ? endDateInputToInstant(endsAt) : null,
      autoApply,
    };
    run(async () => {
      if (editingId) await updatePromotion(editingId, input);
      else await createPromotion(shop.id, input);
      await reload();
      closeForm();
    });
  };

  const removePromotion = () => {
    if (!editingId) return;
    run(async () => {
      const result = await deletePromotion(editingId);
      await reload();
      setConfirmingDelete(false);
      setDeleteResult(result);
    });
  };

  // The one-tap row control: flips `active` without opening the form, for the
  // owner killing a promotion at the counter mid-sale. Deliberately not
  // routed through `run`/`saving` -- that pair drives the edit form's Save
  // button, and a row toggle firing while some other promotion's form is open
  // has no business disabling it.
  const toggleActive = async (promo: Promotion) => {
    setError(null);
    try {
      await updatePromotion(promo.id, { active: !promo.active });
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err, 'Something went wrong.'));
    }
  };

  const counts = useMemo(() => {
    const result = { live: 0, manual: 0, scheduled: 0, expired: 0, paused: 0 };
    for (const p of promotions) result[promoStatus(p, now)]++;
    return result;
  }, [promotions, now]);

  useHeaderActions(
    setHeaderActions,
    <Pressable onPress={startCreate} style={[styles.actionButton, styles.actionButtonSolid]}>
      <Text style={[styles.actionButtonText, styles.actionButtonTextSolid]}>+ New sale</Text>
    </Pressable>,
    []
  );

  const list = (
    <>
      {!loaded ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : promotions.length === 0 ? (
        <Text style={styles.empty}>No promotions yet — add one to get started.</Text>
      ) : (
        <Card variant="bento" style={styles.list}>
          {promotions.map((promo) => {
            const status = promoStatus(promo, now);
            return (
              <Pressable
                key={promo.id}
                onPress={() => startEdit(promo)}
                style={[styles.row, promo.id === editingId && formOpen && styles.rowSelected]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowName}>{promo.name}</Text>
                  <Text style={styles.rowSub}>
                    {discountLabel(promo)} · {scopeLabel(promo)}
                  </Text>
                </View>
                <Pressable
                  onPress={(event) => {
                    // Without this, the tap reaches the row's own onPress too
                    // (the "open this promotion for editing" press) -- same
                    // fix as the date picker's inner sheet in date-input.tsx.
                    event.stopPropagation();
                    toggleActive(promo);
                  }}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: promo.active }}
                  accessibilityLabel={promo.name}
                  style={[styles.rowTogglePill, promo.active && styles.rowTogglePillActive]}
                >
                  <Text style={[styles.rowToggleText, promo.active && styles.rowToggleTextActive]}>{promo.active ? 'Active' : 'Paused'}</Text>
                </Pressable>
                <Badge variant="bento" label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} />
              </Pressable>
            );
          })}
        </Card>
      )}
    </>
  );

  const detail = formOpen ? (
    <BentoCard title={editingId ? 'Edit sale' : 'New sale'}>
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Text style={styles.fieldLabel}>NAME</Text>
      <TextInput value={name} onChangeText={setName} placeholder="Sale name, e.g. Summer Sale" placeholderTextColor={theme.bentoMuted2} style={styles.input} />

      <Text style={styles.fieldLabel}>DISCOUNT</Text>
      <View style={styles.chipRow}>
        <CategoryChip variant="bento" label="% off" active={discountType === 'percentage'} onPress={() => setDiscountType('percentage')} />
        <CategoryChip variant="bento" label="$ off" active={discountType === 'fixed'} onPress={() => setDiscountType('fixed')} />
        <TextInput
          value={discountValue}
          onChangeText={setDiscountValue}
          placeholder={discountType === 'percentage' ? '10' : '5.00'}
          placeholderTextColor={theme.bentoMuted2}
          keyboardType="decimal-pad"
          style={[styles.input, styles.valueInput]}
        />
      </View>

      <Text style={styles.fieldLabel}>APPLIES TO</Text>
      <View style={styles.chipRow}>
        <CategoryChip
          variant="bento"
          label="Entire store"
          active={scope === 'store'}
          onPress={() => {
            setScope('store');
            setScopeValue(null);
          }}
        />
        <CategoryChip
          variant="bento"
          label="A brand"
          active={scope === 'brand'}
          onPress={() => {
            setScope('brand');
            setScopeValue(null);
          }}
        />
        <CategoryChip
          variant="bento"
          label="A category"
          active={scope === 'category'}
          onPress={() => {
            setScope('category');
            setScopeValue(null);
          }}
        />
      </View>
      {scope === 'brand' && (
        <View style={styles.chipRow}>
          {brands.length === 0 ? (
            <Text style={styles.empty}>No brands yet — add one in Inventory first.</Text>
          ) : (
            brands.map((b) => <CategoryChip variant="bento" key={b} label={b} active={scopeValue === b} onPress={() => setScopeValue(b)} />)
          )}
        </View>
      )}
      {scope === 'category' && (
        <View style={styles.chipRow}>
          {categories.length === 0 ? (
            <Text style={styles.empty}>No categories yet — add one in Inventory first.</Text>
          ) : (
            categories.map((c) => <CategoryChip variant="bento" key={c} label={c} active={scopeValue === c} onPress={() => setScopeValue(c)} />)
          )}
        </View>
      )}

      <View style={styles.dateRow}>
        <View style={styles.dateHalf}>
          <Text style={styles.fieldLabel}>STARTS</Text>
          <DateInput value={startsAt ?? ''} onChangeText={(value) => setStartsAt(value || null)} />
          {!startsAt && <Text style={styles.dateHint}>Running now</Text>}
        </View>
        <View style={styles.dateHalf}>
          <Text style={styles.fieldLabel}>ENDS</Text>
          {/* A same-day offer is legal now that the end date is stored
              exclusive (see promotion-dates.ts) -- "Friday only" produces
              ends_at = Saturday 00:00, which is strictly after starts_at.
              So the earliest day worth picking is startsAt itself, not the
              day after it. */}
          <DateInput value={endsAt ?? ''} onChangeText={(value) => setEndsAt(value || null)} minimumDate={startsAt ?? undefined} />
          {!endsAt && <Text style={styles.dateHint}>Until I switch it off</Text>}
        </View>
      </View>

      <Pressable accessibilityRole="switch" accessibilityState={{ checked: autoApply }} onPress={() => setAutoApply((on) => !on)} style={styles.toggleRow}>
        <View style={styles.toggleLabel}>
          <Text style={styles.toggleTitle}>Apply automatically</Text>
          <Text style={styles.toggleHint}>
            {autoApply ? 'Comes off every matching sale on its own.' : 'Only when a cashier picks it.'}
          </Text>
        </View>
        <Switch value={autoApply} onValueChange={setAutoApply} />
      </Pressable>

      <Pressable accessibilityRole="switch" accessibilityState={{ checked: active }} onPress={() => setActive((on) => !on)} style={styles.toggleRow}>
        <View style={styles.toggleLabel}>
          <Text style={styles.toggleTitle}>Active</Text>
          <Text style={styles.toggleHint}>{active ? 'Can come off a sale right now.' : 'Paused — never applies, whatever the window says.'}</Text>
        </View>
        <Switch value={active} onValueChange={setActive} />
      </Pressable>

      {editingId && isFormDirty && !confirmingDelete && !deleteResult && (
        <Text style={styles.dateHint}>Save your changes first — the poster always shows what&apos;s saved, not what&apos;s on this form.</Text>
      )}

      <View style={styles.formActions}>
        {deleteResult ? (
          <>
            <Text style={styles.confirmText}>
              {deleteResult === 'deleted' ? 'Deleted.' : "Archived — it's used in past sales, so it stays on the receipts."}
            </Text>
            <Pressable onPress={closeForm} style={[styles.actionButton, styles.actionButtonSolid]}>
              <Text style={[styles.actionButtonText, styles.actionButtonTextSolid]}>Close</Text>
            </Pressable>
          </>
        ) : (
          <>
            {editingId &&
              (confirmingDelete ? (
                <>
                  <Text style={styles.confirmText}>Delete this sale?</Text>
                  <Pressable onPress={removePromotion} style={styles.actionButton}>
                    <Text style={styles.actionButtonTextDanger}>Confirm</Text>
                  </Pressable>
                  <Pressable onPress={() => setConfirmingDelete(false)} style={styles.actionButton}>
                    <Text style={styles.actionButtonText}>Cancel</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable
                    onPress={() => {
                      if (isFormDirty) return;
                      if (editingPromotion) setPosterPromotion(editingPromotion);
                    }}
                    disabled={isFormDirty}
                    style={[styles.actionButton, isFormDirty && styles.actionButtonDisabled]}
                  >
                    <Text style={styles.actionButtonText}>Poster</Text>
                  </Pressable>
                  <Pressable onPress={() => setConfirmingDelete(true)} style={styles.actionButton}>
                    <Text style={styles.actionButtonTextDanger}>Delete</Text>
                  </Pressable>
                </>
              ))}
            <Pressable onPress={closeForm} style={styles.actionButton}>
              <Text style={styles.actionButtonText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={submit} disabled={!canSave || saving} style={[styles.actionButton, styles.actionButtonSolid, (!canSave || saving) && styles.actionButtonDisabled]}>
              <Text style={[styles.actionButtonText, styles.actionButtonTextSolid]}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Add sale'}</Text>
            </Pressable>
          </>
        )}
      </View>
    </BentoCard>
  ) : (
    <BentoCard style={styles.emptyDetail}>
      <Text style={styles.empty}>Select a promotion to edit it, or add a new one.</Text>
    </BentoCard>
  );

  return (
    <View style={{ flex: 1 }}>
      {error && !formOpen && <Text style={styles.errorText}>{error}</Text>}

      <GlanceStrip style={styles.strip}>
        <StatTile variant="bento" density="dense" value={String(promotions.length)} label="Promotions" hint="not counting archived" />
        <StatTile variant="bento" density="dense" value={String(counts.live)} label="Live now" hint="applying at checkout on their own" />
        <StatTile variant="bento" density="dense" value={String(counts.manual)} label="When picked" hint="ready, but only if a cashier chooses it" />
        <StatTile variant="bento" density="dense" value={String(counts.scheduled)} label="Scheduled" hint="starts in the future" />
        <StatTile variant="bento" density="dense" value={String(counts.paused)} label="Paused" hint="switched off" />
        <StatTile variant="bento" density="dense" value={String(counts.expired)} label="Expired" hint="window has passed" />
      </GlanceStrip>

      <TwoPaneListDetail
        listRefreshControl={pullToRefresh}
        compact={compact}
        list={list}
        detail={detail}
        detailOpen={formOpen}
        onCloseDetail={closeForm}
        detailTitle={editingId ? 'Edit sale' : 'New sale'}
      />

      {posterPromotion && (
        <PosterSheet promotion={posterPromotion} promotions={promotions} onClose={() => setPosterPromotion(null)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { marginBottom: 14 },
  actionButton: {
    borderWidth: 1,
    borderColor: theme.bentoLine,
    backgroundColor: theme.bentoSurface,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  actionButtonSolid: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  actionButtonText: { color: theme.bentoInk2, fontWeight: '700', fontSize: 12.5 },
  actionButtonTextSolid: { color: theme.bentoSurface },
  actionButtonTextDanger: { color: theme.bentoLoss, fontWeight: '700', fontSize: 12.5 },
  actionButtonDisabled: { opacity: 0.5 },
  list: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  rowSelected: { backgroundColor: theme.bentoSoft },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  rowSub: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  rowTogglePill: { borderWidth: 1, borderColor: theme.bentoLine, backgroundColor: theme.bentoSurface, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  rowTogglePillActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  rowToggleText: { fontSize: 10.5, fontWeight: '700', color: theme.bentoMuted },
  rowToggleTextActive: { color: theme.bentoSurface },
  empty: { color: theme.bentoMuted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  emptyDetail: { alignItems: 'center' },
  errorText: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: theme.bentoMuted, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: theme.bentoSoft, borderRadius: 10, height: 42, paddingHorizontal: 12, color: theme.bentoInk },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  valueInput: { minWidth: 90 },
  dateRow: { flexDirection: 'row', gap: 12 },
  dateHalf: { flex: 1 },
  dateHint: { fontSize: 11, color: theme.bentoMuted, marginTop: 4 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 14 },
  toggleLabel: { flex: 1, minWidth: 0 },
  toggleTitle: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  toggleHint: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  formActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 18, flexWrap: 'wrap' },
  confirmText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk },
});
