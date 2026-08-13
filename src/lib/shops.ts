import { uploadImage } from '@/lib/storage';
import { supabase } from '@/lib/supabase';
import type { Shop } from '@/types/models';

function mapShopRow(row: any): Shop {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    returnPolicy: row.return_policy,
    logoUrl: row.logo_url,
    brandColor: row.brand_color ?? null,
    categories: row.categories ?? [],
    payPeriodAnchor: row.pay_period_anchor,
    taxEnabled: row.tax_enabled,
    taxRatePercent: Number(row.tax_rate_percent),
    // Defaulted rather than read straight through: a shop row fetched before
    // the loyalty migration reaches this database has no such columns, and
    // Number(undefined) is NaN -- which renders as a literal "NaN" in the
    // settings field and poisons every calculation downstream. Falling back to
    // the column defaults keeps the UI honest until the migration lands.
    loyaltyEnabled: row.loyalty_enabled ?? false,
    // numeric arrives as a string over PostgREST, same as tax_rate_percent.
    loyaltyPointsPerUsd: row.loyalty_points_per_usd != null ? Number(row.loyalty_points_per_usd) : 1,
    loyaltyCentsPerPoint: row.loyalty_cents_per_point ?? 1,
    loyaltyPointsAvailableAfterDays: row.loyalty_points_available_after_days ?? 1,
    receiptShowLogo: row.receipt_show_logo,
    receiptShowCashierName: row.receipt_show_cashier_name,
    receiptAutoPrint: row.receipt_auto_print,
    receiptAutoWhatsapp: row.receipt_auto_whatsapp,
    paymentCashEnabled: row.payment_cash_enabled,
    paymentZaadEnabled: row.payment_zaad_enabled,
    paymentEdahabEnabled: row.payment_edahab_enabled,
    paymentSplitEnabled: row.payment_split_enabled,
    notifyDailySummary: row.notify_daily_summary,
    notifyLargeSale: row.notify_large_sale,
    notifyLowStock: row.notify_low_stock,
    notifyOutOfStock: row.notify_out_of_stock,
    notifyViaPush: row.notify_via_push,
    notifyViaEmail: row.notify_via_email,
    notifyViaWhatsapp: row.notify_via_whatsapp,
    defaultLowStockLevel: row.default_low_stock_level,
    expiryTrackingEnabled: row.expiry_tracking_enabled,
    expiryWarningLeadDays: row.expiry_warning_lead_days,
    // Defaulted rather than read straight through, for the reason the loyalty
    // fields give above: a row fetched before migration 20260822000000 reaches
    // this database has no such column, and the drawer tally must fall back to
    // an empty note list rather than crash on an undefined map.
    cashDenominations: row.cash_denominations ?? {},
    createdAt: row.created_at,
  };
}

export async function uploadShopLogo(shopId: string, localUri: string): Promise<string> {
  return uploadImage(`${shopId}/logo-${Date.now()}`, localUri);
}

export async function getMyShop(): Promise<Shop | null> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data, error } = await supabase
    .from('shops')
    .select('*')
    .eq('owner_id', userData.user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data) return mapShopRow(data);

  // Not an admin (no shop they own) -- check if they're staff at one instead.
  const { data: membership, error: membershipError } = await supabase
    .from('shop_members')
    .select('shop:shops(*)')
    .eq('user_id', userData.user.id)
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;
  return membership?.shop ? mapShopRow(membership.shop) : null;
}

export async function createShop(input: {
  name: string;
  description?: string;
  city?: string;
  neighborhood?: string;
  contactPhone?: string;
  categories?: string[];
}): Promise<Shop> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('Must be signed in to create a shop');
  const { data, error } = await supabase
    .from('shops')
    .insert({
      owner_id: userData.user.id,
      name: input.name,
      description: input.description ?? null,
      categories: input.categories ?? [],
    })
    .select('*')
    .single();
  if (error) throw error;
  const shop = mapShopRow(data);
  // Same starting currencies the migration backfills for shops that
  // existed before this feature shipped — see migration 0015.
  const { error: currencyError } = await supabase.from('shop_currencies').insert([
    { shop_id: shop.id, code: 'SLSH', name: 'Somaliland Shilling', symbol: 'Sl Sh', rate_to_usd: 115, active: true },
    { shop_id: shop.id, code: 'ETB', name: 'Ethiopian Birr', symbol: 'Br', rate_to_usd: 130, active: false },
  ]);
  if (currencyError) throw currencyError;
  // The primary location, mirroring what migration 20260808000000 backfills for
  // shops that predate it. Every shop must have one from the moment it exists —
  // a shop with no location can't take a sale, and signup is the one path that
  // creates a shop the backfill will never see.
  const { error: locationError } = await supabase.from('shop_locations').insert({
    shop_id: shop.id,
    // The store starts named after the business; a shop with one store keeps
    // them identical, and renames when a second one opens.
    name: input.name,
    city: input.city ?? 'Hargeisa',
    neighborhood: input.neighborhood ?? null,
    contact_phone: input.contactPhone ?? null,
    is_primary: true,
  });
  if (locationError) throw locationError;
  return shop;
}

export async function updateShop(id: string, input: Partial<{
  name: string; description: string; returnPolicy: string; logoUrl: string | null; brandColor: string | null; categories: string[]; payPeriodAnchor: string | null; taxEnabled: boolean; taxRatePercent: number;
  loyaltyEnabled: boolean; loyaltyPointsPerUsd: number; loyaltyCentsPerPoint: number; loyaltyPointsAvailableAfterDays: number;
  receiptShowLogo: boolean; receiptShowCashierName: boolean; receiptAutoPrint: boolean; receiptAutoWhatsapp: boolean;
  paymentCashEnabled: boolean; paymentZaadEnabled: boolean; paymentEdahabEnabled: boolean; paymentSplitEnabled: boolean;
  notifyDailySummary: boolean; notifyLargeSale: boolean; notifyLowStock: boolean; notifyOutOfStock: boolean;
  notifyViaPush: boolean; notifyViaEmail: boolean; notifyViaWhatsapp: boolean;
  defaultLowStockLevel: number; expiryTrackingEnabled: boolean; expiryWarningLeadDays: number;
  cashDenominations: Record<string, number[]>;
}>): Promise<Shop> {
  const { data, error } = await supabase
    .from('shops')
    .update({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.returnPolicy !== undefined && { return_policy: input.returnPolicy }),
      ...(input.logoUrl !== undefined && { logo_url: input.logoUrl }),
      ...(input.brandColor !== undefined && { brand_color: input.brandColor }),
      ...(input.categories !== undefined && { categories: input.categories }),
      ...(input.payPeriodAnchor !== undefined && { pay_period_anchor: input.payPeriodAnchor }),
      ...(input.taxEnabled !== undefined && { tax_enabled: input.taxEnabled }),
      ...(input.taxRatePercent !== undefined && { tax_rate_percent: input.taxRatePercent }),
      ...(input.loyaltyEnabled !== undefined && { loyalty_enabled: input.loyaltyEnabled }),
      ...(input.loyaltyPointsPerUsd !== undefined && { loyalty_points_per_usd: input.loyaltyPointsPerUsd }),
      ...(input.loyaltyCentsPerPoint !== undefined && { loyalty_cents_per_point: input.loyaltyCentsPerPoint }),
      ...(input.loyaltyPointsAvailableAfterDays !== undefined && { loyalty_points_available_after_days: input.loyaltyPointsAvailableAfterDays }),
      ...(input.receiptShowLogo !== undefined && { receipt_show_logo: input.receiptShowLogo }),
      ...(input.receiptShowCashierName !== undefined && { receipt_show_cashier_name: input.receiptShowCashierName }),
      ...(input.receiptAutoPrint !== undefined && { receipt_auto_print: input.receiptAutoPrint }),
      ...(input.receiptAutoWhatsapp !== undefined && { receipt_auto_whatsapp: input.receiptAutoWhatsapp }),
      ...(input.paymentCashEnabled !== undefined && { payment_cash_enabled: input.paymentCashEnabled }),
      ...(input.paymentZaadEnabled !== undefined && { payment_zaad_enabled: input.paymentZaadEnabled }),
      ...(input.paymentEdahabEnabled !== undefined && { payment_edahab_enabled: input.paymentEdahabEnabled }),
      ...(input.paymentSplitEnabled !== undefined && { payment_split_enabled: input.paymentSplitEnabled }),
      ...(input.notifyDailySummary !== undefined && { notify_daily_summary: input.notifyDailySummary }),
      ...(input.notifyLargeSale !== undefined && { notify_large_sale: input.notifyLargeSale }),
      ...(input.notifyLowStock !== undefined && { notify_low_stock: input.notifyLowStock }),
      ...(input.notifyOutOfStock !== undefined && { notify_out_of_stock: input.notifyOutOfStock }),
      ...(input.notifyViaPush !== undefined && { notify_via_push: input.notifyViaPush }),
      ...(input.notifyViaEmail !== undefined && { notify_via_email: input.notifyViaEmail }),
      ...(input.notifyViaWhatsapp !== undefined && { notify_via_whatsapp: input.notifyViaWhatsapp }),
      ...(input.defaultLowStockLevel !== undefined && { default_low_stock_level: input.defaultLowStockLevel }),
      ...(input.expiryTrackingEnabled !== undefined && { expiry_tracking_enabled: input.expiryTrackingEnabled }),
      ...(input.expiryWarningLeadDays !== undefined && { expiry_warning_lead_days: input.expiryWarningLeadDays }),
      ...(input.cashDenominations !== undefined && { cash_denominations: input.cashDenominations }),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapShopRow(data);
}
