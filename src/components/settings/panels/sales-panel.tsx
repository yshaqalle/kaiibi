import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { ManageModal } from '@/components/settings/manage-modal';
import { Btn, PageHeader, Pill, Row, Section, Toggle } from '@/components/settings/settings-primitives';
import { createCurrency, deleteCurrency, setCurrencyActive, updateCurrency } from '@/lib/currencies';
import { formatCents } from '@/lib/currency';
import { createPromotion, deletePromotion, updatePromotion } from '@/lib/promotions';
import { updateShop } from '@/lib/shops';
import type { Currency, Promotion, Shop } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';

const previewCount = 6;
const emptyUsage = new Map<string, number>();

function discountLabel(p: Promotion): string {
  return p.discountType === 'percentage' ? `${p.discountValue}% off` : `${formatCents(p.discountValue)} off`;
}

function scopeLabel(p: Promotion): string {
  if (p.scope === 'store') return 'Entire store';
  if (p.scope === 'brand') return `Brand · ${p.scopeValue}`;
  return `Category · ${p.scopeValue}`;
}

// ─── Promotions ──────────────────────────────────────────────────────────

export function PromotionsPanel({
  shopId,
  promotions,
  brands,
  categories,
  onChange,
}: {
  shopId: string;
  promotions: Promotion[];
  brands: string[];
  categories: string[];
  onChange: () => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const preview = promotions.slice(0, previewCount);

  return (
    <View>
      <PageHeader title="Promotions" />
      <Section title={`Active promotions · ${promotions.length}`}>
        <Text style={styles.hint}>
          Discounts that apply automatically at checkout — for the whole store, a brand, or a category. The cashier can still override with a
          manual discount per item.
        </Text>
        {promotions.length === 0 ? (
          <Text style={styles.empty}>None yet.</Text>
        ) : (
          <View style={styles.pillRow}>
            {preview.map((promo) => (
              <Pill key={promo.id}>
                {promo.name} · {discountLabel(promo)}
                {!promo.active ? ' · Paused' : ''}
              </Pill>
            ))}
            {promotions.length > previewCount && <Pill>+{promotions.length - previewCount} more</Pill>}
          </View>
        )}
        <View style={styles.actionsRow}>
          <Btn onPress={() => setModalOpen(true)}>Manage ({promotions.length})</Btn>
        </View>
      </Section>
      <PromotionsModal visible={modalOpen} onClose={() => setModalOpen(false)} shopId={shopId} promotions={promotions} brands={brands} categories={categories} onChange={onChange} />
    </View>
  );
}

function PromotionsModal({
  visible,
  onClose,
  shopId,
  promotions,
  brands,
  categories,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  shopId: string;
  promotions: Promotion[];
  brands: string[];
  categories: string[];
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [scope, setScope] = useState<'store' | 'brand' | 'category'>('store');
  const [scopeValue, setScopeValue] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setDiscountType('percentage');
    setDiscountValue('');
    setScope('store');
    setScopeValue(null);
  };

  const startEdit = (promo: Promotion) => {
    setEditingId(promo.id);
    setName(promo.name);
    setDiscountType(promo.discountType);
    setDiscountValue(promo.discountType === 'fixed' ? (promo.discountValue / 100).toFixed(2) : String(promo.discountValue));
    setScope(promo.scope);
    setScopeValue(promo.scopeValue);
    setConfirmingDelete(null);
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const submit = () => {
    const trimmedName = name.trim();
    const num = Number(discountValue);
    if (!trimmedName || !num || num <= 0) return;
    if (scope !== 'store' && !scopeValue) return;
    const input = {
      name: trimmedName,
      discountType,
      discountValue: discountType === 'fixed' ? Math.round(num * 100) : Math.min(num, 100),
      scope,
      scopeValue: scope === 'store' ? null : scopeValue,
      active: true,
      startsAt: null,
      endsAt: null,
      autoApply: true,
    };
    run(async () => {
      if (editingId) await updatePromotion(editingId, input);
      else await createPromotion(shopId, input);
      await onChange();
      resetForm();
    });
  };

  const toggleActive = (promo: Promotion) =>
    run(async () => {
      await updatePromotion(promo.id, { active: !promo.active });
      await onChange();
    });

  return (
    <AppModal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>Sales &amp; promotions</Text>
            <View style={modalStyles.headerActions}>
              <Pressable onPress={submit} style={modalStyles.addButton}>
                <Text style={modalStyles.addButtonText}>{editingId ? 'Save changes' : 'Add sale'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={({ pressed }) => [modalStyles.close, pressed && modalStyles.closePressed]}>
                <Text style={modalStyles.closeText}>Done</Text>
              </Pressable>
            </View>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <ScrollView style={modalStyles.list}>
            {promotions.length === 0 && <Text style={styles.empty}>None yet — add one below.</Text>}
            {promotions.map((promo) => (
              <View key={promo.id} style={modalStyles.row}>
                {confirmingDelete === promo.id ? (
                  <>
                    <Text style={[modalStyles.rowLabel, { flex: 1 }]}>Delete &quot;{promo.name}&quot;?</Text>
                    <Pressable
                      onPress={() =>
                        run(async () => {
                          await deletePromotion(promo.id);
                          await onChange();
                          setConfirmingDelete(null);
                        })
                      }
                      style={modalStyles.rowAction}
                    >
                      <Text style={modalStyles.rowActionTextDanger}>Confirm</Text>
                    </Pressable>
                    <Pressable onPress={() => setConfirmingDelete(null)} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextMuted}>Cancel</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={modalStyles.rowLabel}>{promo.name}</Text>
                      <Text style={modalStyles.rowSubLabel}>
                        {discountLabel(promo)} · {scopeLabel(promo)}
                      </Text>
                    </View>
                    <Pressable onPress={() => toggleActive(promo)} style={modalStyles.rowAction}>
                      <Text style={promo.active ? modalStyles.rowActionText : modalStyles.rowActionTextMuted}>{promo.active ? 'Active' : 'Paused'}</Text>
                    </Pressable>
                    <Pressable onPress={() => startEdit(promo)} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionText}>Edit</Text>
                    </Pressable>
                    <Pressable onPress={() => setConfirmingDelete(promo.id)} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextDanger}>Delete</Text>
                    </Pressable>
                  </>
                )}
              </View>
            ))}

            <View style={modalStyles.promoForm}>
              <Text style={modalStyles.fieldLabel}>{editingId ? 'EDIT SALE' : 'NEW SALE'}</Text>
              <TextInput value={name} onChangeText={setName} placeholder="Sale name, e.g. Summer Sale" placeholderTextColor="#999999" style={modalStyles.addInput} />
              <View style={modalStyles.promoRow}>
                <CategoryChip label="% off" active={discountType === 'percentage'} onPress={() => setDiscountType('percentage')} />
                <CategoryChip label="$ off" active={discountType === 'fixed'} onPress={() => setDiscountType('fixed')} />
                <TextInput
                  value={discountValue}
                  onChangeText={setDiscountValue}
                  placeholder={discountType === 'percentage' ? '10' : '5.00'}
                  placeholderTextColor="#999999"
                  keyboardType="decimal-pad"
                  style={modalStyles.promoValueInput}
                />
              </View>
              <Text style={modalStyles.fieldLabel}>APPLIES TO</Text>
              <View style={modalStyles.promoRow}>
                <CategoryChip
                  label="Entire store"
                  active={scope === 'store'}
                  onPress={() => {
                    setScope('store');
                    setScopeValue(null);
                  }}
                />
                <CategoryChip
                  label="A brand"
                  active={scope === 'brand'}
                  onPress={() => {
                    setScope('brand');
                    setScopeValue(null);
                  }}
                />
                <CategoryChip
                  label="A category"
                  active={scope === 'category'}
                  onPress={() => {
                    setScope('category');
                    setScopeValue(null);
                  }}
                />
              </View>
              {scope === 'brand' && (
                <View style={modalStyles.promoRow}>
                  {brands.length === 0 ? (
                    <Text style={styles.empty}>No brands yet — add one above first.</Text>
                  ) : (
                    brands.map((b) => <CategoryChip key={b} label={b} active={scopeValue === b} onPress={() => setScopeValue(b)} />)
                  )}
                </View>
              )}
              {scope === 'category' && (
                <View style={modalStyles.promoRow}>
                  {categories.length === 0 ? (
                    <Text style={styles.empty}>No categories yet — add one above first.</Text>
                  ) : (
                    categories.map((c) => <CategoryChip key={c} label={c} active={scopeValue === c} onPress={() => setScopeValue(c)} />)
                  )}
                </View>
              )}
              <View style={modalStyles.promoFormActions}>
                {editingId && (
                  <Pressable onPress={resetForm} style={modalStyles.rowAction}>
                    <Text style={modalStyles.rowActionTextMuted}>Cancel edit</Text>
                  </Pressable>
                )}
                <Pressable onPress={submit} style={modalStyles.addButton}>
                  <Text style={modalStyles.addButtonText}>{editingId ? 'Save changes' : 'Add sale'}</Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

// ─── Tax and currencies ──────────────────────────────────────────────────

function TaxSubsection({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [taxEnabled, setTaxEnabled] = useState(shop.taxEnabled);
  const [taxRateInput, setTaxRateInput] = useState(String(shop.taxRatePercent));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = taxEnabled !== shop.taxEnabled || taxRateInput.trim() !== String(shop.taxRatePercent);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, { taxEnabled, taxRatePercent: Number(taxRateInput) || 0 });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Tax">
      <Text style={styles.hint}>When enabled, this rate is added to every sale total, on top of any discounts.</Text>
      <Row label="Charge tax" desc={taxEnabled ? `${taxRateInput || 0}% on every sale` : 'Disabled'}>
        <Toggle value={taxEnabled} onValueChange={setTaxEnabled} />
      </Row>
      {taxEnabled && (
        <Row label="Tax rate">
          <TextInput value={taxRateInput} onChangeText={setTaxRateInput} placeholder="2.5" placeholderTextColor="#999999" keyboardType="decimal-pad" style={styles.rateInput} />
          <Text style={styles.percentSign}>%</Text>
        </Row>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.actionsRow}>
        <Btn onPress={save} disabled={!dirty || saving}>
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
        </Btn>
      </View>
    </Section>
  );
}

function CurrenciesPillSection({ shopId, currencies, onChange }: { shopId: string; currencies: Currency[]; onChange: () => Promise<void> }) {
  const [modalOpen, setModalOpen] = useState(false);
  const preview = currencies.slice(0, previewCount);

  return (
    <Section title={`Currencies · ${currencies.filter((c) => c.active).length} active`}>
      <Text style={styles.hint}>Alternate currencies a cashier can accept at checkout, converted to USD by the rate below. Sales are always recorded in USD.</Text>
      {currencies.length === 0 ? (
        <Text style={styles.empty}>None yet.</Text>
      ) : (
        <View style={styles.pillRow}>
          {preview.map((c) => (
            <Pill key={c.id}>
              {c.code} · {c.rateToUsd}/$1{!c.active ? ' · Inactive' : ''}
            </Pill>
          ))}
        </View>
      )}
      <View style={styles.actionsRow}>
        <Btn onPress={() => setModalOpen(true)}>Manage ({currencies.length})</Btn>
      </View>
      <CurrenciesModal visible={modalOpen} onClose={() => setModalOpen(false)} shopId={shopId} currencies={currencies} onChange={onChange} />
    </Section>
  );
}

function CurrenciesModal({
  visible,
  onClose,
  shopId,
  currencies,
  onChange,
}: {
  visible: boolean;
  onClose: () => void;
  shopId: string;
  currencies: Currency[];
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [rateInput, setRateInput] = useState('');

  const resetForm = () => {
    setEditingId(null);
    setCode('');
    setName('');
    setSymbol('');
    setRateInput('');
  };

  const startEdit = (currency: Currency) => {
    setEditingId(currency.id);
    setCode(currency.code);
    setName(currency.name);
    setSymbol(currency.symbol);
    setRateInput(String(currency.rateToUsd));
    setConfirmingDelete(null);
  };

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  const submit = () => {
    const trimmedCode = code.trim().toUpperCase();
    const trimmedName = name.trim();
    const trimmedSymbol = symbol.trim();
    const rate = Number(rateInput);
    if (!trimmedName || !trimmedSymbol || !rate || rate <= 0) return;
    run(async () => {
      if (editingId) {
        await updateCurrency(editingId, { name: trimmedName, symbol: trimmedSymbol, rateToUsd: rate });
      } else {
        if (!trimmedCode) return;
        await createCurrency(shopId, { code: trimmedCode, name: trimmedName, symbol: trimmedSymbol, rateToUsd: rate });
      }
      await onChange();
      resetForm();
    });
  };

  const toggleActive = (currency: Currency) =>
    run(async () => {
      await setCurrencyActive(currency.id, !currency.active);
      await onChange();
    });

  return (
    <AppModal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={modalStyles.overlay}>
        <View style={modalStyles.card}>
          <View style={modalStyles.header}>
            <Text style={modalStyles.title}>Currencies</Text>
            <View style={modalStyles.headerActions}>
              <Pressable onPress={submit} style={modalStyles.addButton}>
                <Text style={modalStyles.addButtonText}>{editingId ? 'Save changes' : 'Add currency'}</Text>
              </Pressable>
              <Pressable onPress={onClose} style={({ pressed }) => [modalStyles.close, pressed && modalStyles.closePressed]}>
                <Text style={modalStyles.closeText}>Done</Text>
              </Pressable>
            </View>
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <ScrollView style={modalStyles.list}>
            {currencies.length === 0 && <Text style={styles.empty}>None yet — add one below.</Text>}
            {currencies.map((currency) => (
              <View key={currency.id} style={modalStyles.row}>
                {confirmingDelete === currency.id ? (
                  <>
                    <Text style={[modalStyles.rowLabel, { flex: 1 }]}>Delete &quot;{currency.code}&quot;?</Text>
                    <Pressable
                      onPress={() =>
                        run(async () => {
                          await deleteCurrency(currency.id);
                          await onChange();
                          setConfirmingDelete(null);
                        })
                      }
                      style={modalStyles.rowAction}
                    >
                      <Text style={modalStyles.rowActionTextDanger}>Confirm</Text>
                    </Pressable>
                    <Pressable onPress={() => setConfirmingDelete(null)} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextMuted}>Cancel</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={modalStyles.rowLabel}>
                        {currency.code} · {currency.name}
                      </Text>
                      <Text style={modalStyles.rowSubLabel}>
                        {currency.symbol} · {currency.rateToUsd} per $1
                      </Text>
                    </View>
                    <Pressable onPress={() => toggleActive(currency)} style={modalStyles.rowAction}>
                      <Text style={currency.active ? modalStyles.rowActionText : modalStyles.rowActionTextMuted}>{currency.active ? 'Active' : 'Inactive'}</Text>
                    </Pressable>
                    <Pressable onPress={() => startEdit(currency)} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionText}>Edit</Text>
                    </Pressable>
                    <Pressable onPress={() => setConfirmingDelete(currency.id)} style={modalStyles.rowAction}>
                      <Text style={modalStyles.rowActionTextDanger}>Delete</Text>
                    </Pressable>
                  </>
                )}
              </View>
            ))}

            <View style={modalStyles.promoForm}>
              <Text style={modalStyles.fieldLabel}>{editingId ? 'EDIT CURRENCY' : 'NEW CURRENCY'}</Text>
              <View style={modalStyles.formRow}>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.fieldLabel}>CODE</Text>
                  {editingId ? (
                    <View style={modalStyles.readOnlyField}>
                      <Text style={modalStyles.readOnlyFieldText}>{code}</Text>
                    </View>
                  ) : (
                    <TextInput value={code} onChangeText={setCode} placeholder="SLSH" placeholderTextColor="#999999" autoCapitalize="characters" style={modalStyles.formInput} />
                  )}
                </View>
                <View style={{ flex: 2 }}>
                  <Text style={modalStyles.fieldLabel}>NAME</Text>
                  <TextInput value={name} onChangeText={setName} placeholder="Somaliland Shilling" placeholderTextColor="#999999" style={modalStyles.formInput} />
                </View>
              </View>
              <View style={modalStyles.formRow}>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.fieldLabel}>SYMBOL</Text>
                  <TextInput value={symbol} onChangeText={setSymbol} placeholder="Sl Sh" placeholderTextColor="#999999" style={modalStyles.formInput} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={modalStyles.fieldLabel}>RATE (PER $1)</Text>
                  <TextInput value={rateInput} onChangeText={setRateInput} placeholder="115" placeholderTextColor="#999999" keyboardType="decimal-pad" style={modalStyles.formInput} />
                </View>
              </View>
              <View style={modalStyles.promoFormActions}>
                {editingId && (
                  <Pressable onPress={resetForm} style={modalStyles.rowAction}>
                    <Text style={modalStyles.rowActionTextMuted}>Cancel edit</Text>
                  </Pressable>
                )}
                <Pressable onPress={submit} style={modalStyles.addButton}>
                  <Text style={modalStyles.addButtonText}>{editingId ? 'Save changes' : 'Add currency'}</Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </AppModal>
  );
}

export function TaxAndCurrenciesPanel({
  shop,
  onShopSaved,
  currencies,
  onCurrenciesChange,
}: {
  shop: Shop;
  onShopSaved: () => Promise<void>;
  currencies: Currency[];
  onCurrenciesChange: () => Promise<void>;
}) {
  return (
    <View>
      <PageHeader title="Tax and currencies" />
      <TaxSubsection shop={shop} onSaved={onShopSaved} />
      <CurrenciesPillSection shopId={shop.id} currencies={currencies} onChange={onCurrenciesChange} />
    </View>
  );
}

// ─── Loyalty ─────────────────────────────────────────────────────────────

// Two rates rather than one, because the earn rate alone doesn't say what the
// programme costs: a point per dollar is a 1% programme at 100 points to the
// dollar and a 10% one at 10. Keeping them apart also lets the earn rate stay
// the simple sentence a shop tells its customers.
//
// BOTH FIELDS ARE EXPRESSED IN POINTS, deliberately. The database stores the
// second as cents-per-point (integer, so a redemption is always exact and never
// rounds), but nobody setting up a loyalty scheme thinks in cents per point --
// they think "a hundred points gets you a dollar off". Asking for cents here
// invites entering 100 and quietly promising to give every dollar straight
// back, which is a 100x error in what the shop pays out. So the field asks for
// the number a shop owner already has in their head and converts.
const DEFAULT_POINTS_FOR_A_DOLLAR = 100;

// Both directions of the conversion in one place, so they can't drift.
const pointsForADollarFrom = (centsPerPoint: number) =>
  centsPerPoint > 0 ? Math.round(100 / centsPerPoint) : DEFAULT_POINTS_FOR_A_DOLLAR;
const centsPerPointFrom = (pointsForADollar: number) =>
  pointsForADollar > 0 ? Math.max(1, Math.round(100 / pointsForADollar)) : 100;

export function LoyaltyPanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(shop.loyaltyEnabled);
  const [perUsdInput, setPerUsdInput] = useState(String(shop.loyaltyPointsPerUsd));
  const [pointsForDollarInput, setPointsForDollarInput] = useState(String(pointsForADollarFrom(shop.loyaltyCentsPerPoint)));
  const [graceDaysInput, setGraceDaysInput] = useState(String(shop.loyaltyPointsAvailableAfterDays));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    enabled !== shop.loyaltyEnabled ||
    perUsdInput.trim() !== String(shop.loyaltyPointsPerUsd) ||
    pointsForDollarInput.trim() !== String(pointsForADollarFrom(shop.loyaltyCentsPerPoint)) ||
    graceDaysInput.trim() !== String(shop.loyaltyPointsAvailableAfterDays);

  const pointsForADollar = Math.max(1, Math.floor(Number(pointsForDollarInput) || 0));
  const centsPerPoint = centsPerPointFrom(pointsForADollar);
  const pointsPerUsd = Number(perUsdInput) || 0;
  // The round trip, spelled out. Neither field says on its own what the
  // programme costs -- that's the PRODUCT of the two -- so it gets stated as a
  // sentence before Save rather than discovered at the till.
  const graceDays = Math.max(0, Math.floor(Number(graceDaysInput) || 0));
  const centsBackPerDollar = Math.round(pointsPerUsd * centsPerPoint);
  const givingItAllBack = centsBackPerDollar >= 100;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, {
        loyaltyEnabled: enabled,
        loyaltyPointsPerUsd: pointsPerUsd,
        loyaltyCentsPerPoint: centsPerPoint,
        loyaltyPointsAvailableAfterDays: graceDays,
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      // Supabase errors are plain {code, details, hint, message} objects, never
      // instanceof Error -- checking that first always falls through to the
      // fallback and hides the real Postgres message ("column ... does not
      // exist" reads as a mystery). Same fix as customer-picker.tsx.
      setError(
        err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Could not save changes.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <PageHeader title="Loyalty" />
      <Section title="Loyalty points">
        <Text style={styles.hint}>
          Customers earn points on what they pay for goods, before tax and after any discount. They can spend them at checkout for money
          off. Points only apply to sales with a customer attached.
        </Text>
        <Row label="Earn points" desc={enabled ? `${pointsPerUsd} per $1 spent` : 'Disabled'}>
          <Toggle value={enabled} onValueChange={setEnabled} />
        </Row>
        {enabled && (
          <>
            <Row label="Points per $1">
              <TextInput
                value={perUsdInput}
                onChangeText={setPerUsdInput}
                placeholder="1"
                placeholderTextColor="#999999"
                keyboardType="decimal-pad"
                style={styles.rateInput}
              />
            </Row>
            <Row label="Points for $1.00 off" desc={`Each point is worth ${formatCents(centsPerPoint)}`}>
              <TextInput
                value={pointsForDollarInput}
                onChangeText={setPointsForDollarInput}
                placeholder={String(DEFAULT_POINTS_FOR_A_DOLLAR)}
                placeholderTextColor="#999999"
                keyboardType="number-pad"
                style={styles.rateInput}
              />
              <Text style={styles.percentSign}>pts</Text>
            </Row>
            <Row
              label="Usable after"
              desc={
                graceDays === 0
                  ? 'Spendable the moment they are earned'
                  : `Points earned today can be spent in ${graceDays} ${graceDays === 1 ? 'day' : 'days'}`
              }
            >
              <TextInput
                value={graceDaysInput}
                onChangeText={setGraceDaysInput}
                placeholder="1"
                placeholderTextColor="#999999"
                keyboardType="number-pad"
                style={styles.rateInput}
              />
              <Text style={styles.percentSign}>{graceDays === 1 ? 'day' : 'days'}</Text>
            </Row>
            {graceDays === 0 && (
              <Text style={[styles.hint, styles.loyaltySummary, styles.loyaltyWarning]}>
                With no waiting period a customer can buy, earn, spend the new points on a second basket, and return the first —
                and the refund can only claw back points they still hold.
              </Text>
            )}
            <Text style={[styles.hint, styles.loyaltySummary, givingItAllBack && styles.loyaltyWarning]}>
              {`Spend $1.00 → earn ${pointsPerUsd} ${pointsPerUsd === 1 ? 'point' : 'points'} → worth ${formatCents(centsBackPerDollar)} off.`}
              {givingItAllBack ? ' That gives back every dollar spent, or more — check both numbers.' : ''}
            </Text>
          </>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.actionsRow}>
          <Btn onPress={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
          </Btn>
        </View>
      </Section>
    </View>
  );
}

// ─── Cashiers ────────────────────────────────────────────────────────────

export function CashiersPanel({
  shopId,
  cashiers,
  onAdd,
  onRename,
  onDelete,
}: {
  shopId: string;
  cashiers: string[];
  onAdd: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const preview = cashiers.slice(0, previewCount);

  return (
    <View>
      <PageHeader title="Cashiers" />
      <Section title={`Current cashiers · ${cashiers.length}`}>
        <Text style={styles.hint}>
          Who can be picked as the cashier at checkout in the POS. Shown on the receipt as “Served by”. Renaming or removing one only affects future
          sales — past receipts keep the name as it was at the time.
        </Text>
        {cashiers.length === 0 ? (
          <Text style={styles.empty}>None yet.</Text>
        ) : (
          <View style={styles.pillRow}>
            {preview.map((c) => (
              <Pill key={c}>{c}</Pill>
            ))}
            {cashiers.length > previewCount && <Pill>+{cashiers.length - previewCount} more</Pill>}
          </View>
        )}
        <View style={styles.actionsRow}>
          <Btn onPress={() => setModalOpen(true)}>Manage ({cashiers.length})</Btn>
        </View>
      </Section>
      <ManageModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        title="CASHIERS"
        itemLabel="cashier"
        items={cashiers}
        usage={emptyUsage}
        showUsage={false}
        onAdd={onAdd}
        onRename={onRename}
        onDelete={onDelete}
      />
    </View>
  );
}

// ─── Payments ────────────────────────────────────────────────────────────

// Only lists payment methods that actually exist in the POS today
// (`lib/payment-methods.ts`: cash/zaad/edahab/other) — EVC Plus and Card
// aren't real `PaymentMethod` values anywhere in the app, so they're left
// out entirely rather than shown as a toggle for something that can't
// actually be turned on. Wired to `payment-method-picker.tsx`'s
// `enabledMethods`/`allowSplit` props via the shop columns from migration
// 0027 — toggling these here actually changes what the POS offers.
export function PaymentsPanel({ shop, onSaved }: { shop: Shop; onSaved: () => Promise<void> }) {
  const [cash, setCash] = useState(shop.paymentCashEnabled);
  const [zaad, setZaad] = useState(shop.paymentZaadEnabled);
  const [eDahab, setEDahab] = useState(shop.paymentEdahabEnabled);
  const [splitPayment, setSplitPayment] = useState(shop.paymentSplitEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    cash !== shop.paymentCashEnabled ||
    zaad !== shop.paymentZaadEnabled ||
    eDahab !== shop.paymentEdahabEnabled ||
    splitPayment !== shop.paymentSplitEnabled;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateShop(shop.id, {
        paymentCashEnabled: cash,
        paymentZaadEnabled: zaad,
        paymentEdahabEnabled: eDahab,
        paymentSplitEnabled: splitPayment,
      });
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <PageHeader title="Payments" actionLabel={saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'} onAction={save} actionDisabled={!dirty || saving} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Section title="Accepted payment methods">
        <Row label="Cash">
          <Toggle value={cash} onValueChange={setCash} />
        </Row>
        <Row label="ZAAD" desc="Telesom mobile money">
          <Toggle value={zaad} onValueChange={setZaad} />
        </Row>
        <Row label="e-Dahab" desc="Somtel mobile money">
          <Toggle value={eDahab} onValueChange={setEDahab} />
        </Row>
      </Section>
      <Section title="Split payment">
        <Row label="Allow split payment" desc="Part cash, part mobile money in one transaction">
          <Toggle value={splitPayment} onValueChange={setSplitPayment} />
        </Row>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginBottom: 12 },
  empty: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  actionsRow: { flexDirection: 'row', gap: 8 },
  error: { color: '#C0392B', fontSize: 13, fontWeight: '700', marginBottom: 16 },
  rateInput: { width: 60, fontSize: 14, fontWeight: '700', color: '#111111', textAlign: 'right' },
  percentSign: { fontSize: 14, fontWeight: '700', color: '#9CA3AF' },
  loyaltySummary: { marginTop: 12, marginBottom: 4 },
  loyaltyWarning: { color: '#9A6700', fontWeight: '700' },
});

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 560, height: '80%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  list: { flex: 1, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F2F2F2', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  rowLabel: { fontSize: 13, fontWeight: '700', color: '#111111' },
  rowSubLabel: { fontSize: 11, color: '#999999', marginTop: 2 },
  rowAction: { paddingVertical: 4, paddingHorizontal: 4 },
  rowActionText: { fontSize: 12, fontWeight: '700', color: '#111111' },
  rowActionTextMuted: { fontSize: 12, fontWeight: '700', color: '#999999' },
  rowActionTextDanger: { fontSize: 12, fontWeight: '700', color: '#C0392B' },
  addRow: { flexDirection: 'row', gap: 8 },
  addInput: { flex: 1, backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
  promoForm: { borderTopWidth: 1, borderTopColor: '#ECECEC', paddingTop: 14, gap: 8 },
  promoRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  promoValueInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111', minWidth: 90 },
  promoFormActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 4 },
  fieldLabel: { fontSize: 10, letterSpacing: 0.6, fontWeight: '800', color: '#999999', marginBottom: 6, marginTop: 10 },
  formRow: { flexDirection: 'row', gap: 12 },
  formInput: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 12, color: '#111111' },
  readOnlyField: { backgroundColor: '#F7F7F7', borderRadius: 10, height: 42, paddingHorizontal: 12, justifyContent: 'center' },
  readOnlyFieldText: { color: '#666666', fontSize: 14 },
});
