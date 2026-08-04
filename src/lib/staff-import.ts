import { toCents } from '@/lib/currency';
import type { ParsedCsv } from '@/lib/csv';
import type { ImportReport, RejectedRow } from '@/lib/import-shared';
import type { PayCadence } from '@/lib/pay-periods';
import { isValidRateInput, payRateUnitLabel } from '@/lib/pay-rate';
import { provisionStaff, updateStaffPay } from '@/lib/staff';
import type { Role, StaffMember } from '@/types/models';

export const STAFF_TEMPLATE_COLUMNS: { header: string; required: boolean }[] = [
  { header: 'Full Name', required: true },
  { header: 'Email', required: true },
  { header: 'Role', required: true },
  { header: 'Password', required: false },
];

export const STAFF_EXAMPLE_ROW: Record<string, string> = {
  'Full Name': 'Hamse Jibril',
  Email: 'hamse@example.com',
  Role: 'Cashier',
  Password: '',
};

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
export function parseStaffPayColumns(raw: Record<string, string>): StaffPayColumns {
  const payTypeRaw = raw['Pay Type']?.trim().toLowerCase() ?? '';
  const rateRaw = raw['Pay Rate']?.trim() ?? '';
  const cadenceRaw = raw['Pay Cadence']?.trim().toLowerCase() ?? '';
  const unitRaw = raw['Pay Rate Unit']?.trim().toLowerCase() ?? '';

  if (!payTypeRaw && !rateRaw && !cadenceRaw) return { kind: 'none' };

  if (!payTypeRaw) {
    return { kind: 'error', reason: 'Pay Rate or Pay Cadence given without a Pay Type — add one of hourly, salary or fixed.' };
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

  let payCadence: PayCadence = 'monthly';
  if (cadenceRaw) {
    const found = CADENCES.find((cadence) => cadence === cadenceRaw);
    if (!found) {
      return {
        kind: 'error',
        reason: `Pay Cadence "${raw['Pay Cadence']?.trim()}" is not one of weekly, biweekly, semimonthly or monthly.`,
      };
    }
    payCadence = found;
  }

  if (unitRaw && unitRaw !== payRateUnitLabel(payType)) {
    return {
      kind: 'error',
      reason: `Pay Rate Unit "${raw['Pay Rate Unit']?.trim()}" doesn't match Pay Type "${payType}" (expected "${payRateUnitLabel(payType)}").`,
    };
  }

  return { kind: 'ok', patch: { payType, payRateCents, payCadence } };
}

// Unlike runCustomersImport, this can't bulk-insert -- provisioning a staff
// member mints a real login via the provision-staff Edge Function (one auth
// user + one shop_members row per call), so there's no batching RPC and
// shouldn't be one. Rows are processed sequentially; acceptable since staff
// imports are rare and small compared to customer imports.
export async function runStaffImport(
  shopId: string,
  roles: Role[],
  parsed: ParsedCsv,
  canManagePayroll: boolean
): Promise<ImportReport<StaffMember>> {
  const roleByName = new Map(roles.map((r) => [r.name.toLowerCase(), r]));
  const rejected: RejectedRow[] = [];
  const accepted: StaffMember[] = [];

  for (let i = 0; i < parsed.rows.length; i++) {
    const raw = parsed.rows[i];
    const row = i + 2; // header occupies row 1 in the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const fullName = raw['Full Name']?.trim();
    const email = raw['Email']?.trim();
    const roleName = raw['Role']?.trim();
    if (!fullName) {
      reject('Full Name is required.');
      continue;
    }
    if (!email) {
      reject('Email is required.');
      continue;
    }
    if (!roleName) {
      reject('Role is required.');
      continue;
    }
    const role = roleByName.get(roleName.toLowerCase());
    if (!role) {
      reject(`Role "${roleName}" does not match an existing role — create it in Settings first.`);
      continue;
    }

    // Without the permission the columns are ignored rather than rejected --
    // someone who cannot see pay should still be able to import names and
    // roles.
    const pay = canManagePayroll ? parseStaffPayColumns(raw) : ({ kind: 'none' } as const);
    if (pay.kind === 'error') {
      reject(pay.reason);
      continue;
    }

    try {
      const created = await provisionStaff({ shopId, fullName, email, password: raw['Password']?.trim() || undefined, roleId: role.id });

      if (pay.kind === 'ok') {
        try {
          await updateStaffPay(created.member.id, pay.patch);
        } catch (err) {
          // The member EXISTS at this point. Reporting them accepted would hide
          // a roster with no pay set; reporting a plain rejection would imply
          // nothing was created and invite a re-import that fails on duplicate
          // email. So the reason says exactly what happened.
          reject(
            `Staff member was created, but their pay could not be set (${err instanceof Error ? err.message : 'unknown error'}). Set it in People.`
          );
          continue;
        }
      }

      accepted.push({
        id: created.member.id,
        shopId,
        userId: created.userId,
        roleId: role.id,
        roleName: role.name,
        active: true,
        fullName,
        email: created.email,
        createdAt: new Date().toISOString(),
        hireDate: null,
        payType: pay.kind === 'ok' ? pay.patch.payType : null,
        payRateCents: pay.kind === 'ok' ? pay.patch.payRateCents : null,
        payCadence: pay.kind === 'ok' ? pay.patch.payCadence : 'monthly',
      });
    } catch (err) {
      reject(err instanceof Error ? err.message : 'Could not add this staff member.');
    }
  }

  return { accepted, rejected };
}
