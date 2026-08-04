import { toCents } from '@/lib/currency';
import type { PayCadence } from '@/lib/pay-periods';
import { isValidRateInput, payRateUnitLabel } from '@/lib/pay-rate';
import type { StaffMember } from '@/types/models';

// Pure CSV-column parsing, split out of staff-import.ts (which pulls in the
// staff-provisioning module and, through it, the auth client) so it can be
// unit-tested without the Supabase client -- same reasoning as
// payroll-reporting.ts.

const PAY_TYPES = ['hourly', 'salary', 'fixed'] as const;
const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;

export type StaffPayColumns =
  | { kind: 'none' }
  | { kind: 'ok'; patch: { payType: StaffMember['payType']; payRateCents: number | null; payCadence: PayCadence } }
  | { kind: 'error'; reason: string };

// Maps the pay columns of one CSV row to a pay patch, or to a reason the row
// can't be accepted. Pure, so the logic worth defending is testable without
// stubbing the provisioning Edge Function.
//
// `Pay Rate Unit` is informational and never converts: a salaried rate is
// canonically per month (see pay-rate.ts), which is exactly what the export
// writes. It IS validated, because a file claiming "per hour" beside a salary
// is self-contradictory and guessing which half is right would misstate pay.
// Pay Cadence alone, since it's shared by both the typed and untyped paths
// below: parsed the same way regardless of whether a Pay Type is present.
function parseCadence(cadenceRaw: string, cadenceDisplay: string | undefined): { kind: 'ok'; payCadence: PayCadence } | { kind: 'error'; reason: string } {
  if (!cadenceRaw) return { kind: 'ok', payCadence: 'monthly' };
  const found = CADENCES.find((cadence) => cadence === cadenceRaw);
  if (!found) {
    return {
      kind: 'error',
      reason: `Pay Cadence "${cadenceDisplay}" is not one of weekly, biweekly, semimonthly or monthly.`,
    };
  }
  return { kind: 'ok', payCadence: found };
}

export function parseStaffPayColumns(raw: Record<string, string>): StaffPayColumns {
  const payTypeRaw = raw['Pay Type']?.trim().toLowerCase() ?? '';
  const rateRaw = raw['Pay Rate']?.trim() ?? '';
  const cadenceRaw = raw['Pay Cadence']?.trim().toLowerCase() ?? '';
  const unitRaw = raw['Pay Rate Unit']?.trim().toLowerCase() ?? '';

  if (!payTypeRaw && !rateRaw && !cadenceRaw) return { kind: 'none' };

  // Pay Cadence is NOT NULL and independent of pay_type -- the export writes
  // it for every member, including the common case of one with no pay set
  // yet (Pay Type/Rate/Unit all blank). A cadence with no type is therefore
  // unambiguous and must round-trip. A rate with no type is different: it has
  // no unit to interpret it by, so that combination is still rejected below.
  if (!payTypeRaw && rateRaw) {
    return { kind: 'error', reason: 'Pay Rate given without a Pay Type — add one of hourly, salary or fixed.' };
  }

  if (!payTypeRaw) {
    const cadence = parseCadence(cadenceRaw, raw['Pay Cadence']?.trim());
    if (cadence.kind === 'error') return cadence;
    return { kind: 'ok', patch: { payType: null, payRateCents: null, payCadence: cadence.payCadence } };
  }

  const payType = PAY_TYPES.find((type) => type === payTypeRaw);
  if (!payType) {
    return { kind: 'error', reason: `Pay Type "${raw['Pay Type']?.trim()}" is not one of hourly, salary or fixed.` };
  }

  let payRateCents: number | null = null;
  if (rateRaw) {
    if (!isValidRateInput(rateRaw.replace(/[$,]/g, ''))) {
      return { kind: 'error', reason: `Pay Rate "${rateRaw}" is not a number.` };
    }
    payRateCents = toCents(rateRaw);
  }

  const cadence = parseCadence(cadenceRaw, raw['Pay Cadence']?.trim());
  if (cadence.kind === 'error') return cadence;
  const payCadence = cadence.payCadence;

  if (unitRaw && unitRaw !== payRateUnitLabel(payType)) {
    return {
      kind: 'error',
      reason: `Pay Rate Unit "${raw['Pay Rate Unit']?.trim()}" doesn't match Pay Type "${payType}" (expected "${payRateUnitLabel(payType)}").`,
    };
  }

  return { kind: 'ok', patch: { payType, payRateCents, payCadence } };
}
