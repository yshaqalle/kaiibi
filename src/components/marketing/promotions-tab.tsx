import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useDetailSelection, useHeaderActions, type DetailSelectionSetter, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { Badge } from '@/components/badge';
import { Card } from '@/components/card';
import { CategoryChip } from '@/components/category-chip';
import { DateInput } from '@/components/date-input';
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
import { formatCents } from '@/lib/currency';
import { createPromotion, deletePromotion, listPromotions, updatePromotion, type NewPromotionInput } from '@/lib/promotions';
import type { Promotion } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet. Matches
// people.tsx: People is a bento screen (see two-pane-list-detail.tsx), not the
// cream one — this tab reads theme.bento* the same way CustomersTab does.
const theme = Colors.light;

export function discountLabel(p: Promotion): string {
  return p.discountType === 'percentage' ? `${p.discountValue}% off` : `${formatCents(p.discountValue)} off`;
}

export function scopeLabel(p: Promotion): string {
  if (p.scope === 'store') return 'Entire store';
  if (p.scope === 'brand') return `Brand · ${p.scopeValue}`;
  return `Category · ${p.scopeValue}`;
}

// 'live'/'scheduled'/'expired'/'paused' -- deliberately the same three clauses
// as isPromotionLive (lib/discounts.ts), just not collapsed to a boolean, so a
// row can say WHY something isn't applying rather than only that it isn't.
type PromoStatus = 'live' | 'scheduled' | 'expired' | 'paused';

function promoStatus(p: Promotion, now: number): PromoStatus {
  if (!p.active) return 'paused';
  if (p.startsAt && Date.parse(p.startsAt) > now) return 'scheduled';
  if (p.endsAt && Date.parse(p.endsAt) <= now) return 'expired';
  return 'live';
}

const STATUS_LABEL: Record<PromoStatus, string> = {
  live: 'Live',
  scheduled: 'Scheduled',
  expired: 'Expired',
  paused: 'Paused',
};

const STATUS_TONE: Record<PromoStatus, 'default' | 'success' | 'warning'> = {
  live: 'success',
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
      setError(err instanceof Error ? err.message : 'Something went wrong.');
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
    setStartsAt(promo.startsAt);
    setEndsAt(promo.endsAt);
    setAutoApply(promo.autoApply);
    setConfirmingDelete(false);
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
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  };

  const canSave = name.trim().length > 0 && Number(discountValue) > 0 && (scope === 'store' || Boolean(scopeValue));

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
      startsAt,
      endsAt,
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
      await deletePromotion(editingId);
      await reload();
      closeForm();
    });
  };

  const counts = useMemo(() => {
    const result = { live: 0, scheduled: 0, expired: 0, paused: 0 };
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

      <View style={styles.formActions}>
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
            <Pressable onPress={() => setConfirmingDelete(true)} style={styles.actionButton}>
              <Text style={styles.actionButtonTextDanger}>Delete</Text>
            </Pressable>
          ))}
        <Pressable onPress={closeForm} style={styles.actionButton}>
          <Text style={styles.actionButtonText}>Cancel</Text>
        </Pressable>
        <Pressable onPress={submit} disabled={!canSave || saving} style={[styles.actionButton, styles.actionButtonSolid, (!canSave || saving) && styles.actionButtonDisabled]}>
          <Text style={[styles.actionButtonText, styles.actionButtonTextSolid]}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Add sale'}</Text>
        </Pressable>
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
        <StatTile variant="bento" density="dense" value={String(counts.live)} label="Live now" hint="applying at checkout" />
        <StatTile variant="bento" density="dense" value={String(counts.scheduled)} label="Scheduled" hint="starts in the future" />
        <StatTile variant="bento" density="dense" value={String(counts.paused)} label="Paused" hint="switched off" />
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
