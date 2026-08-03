import type { ParsedCsv } from '@/lib/csv';
import type { ImportReport, RejectedRow } from '@/lib/import-shared';
import { provisionStaff } from '@/lib/staff';
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

// Unlike runCustomersImport, this can't bulk-insert -- provisioning a staff
// member mints a real login via the provision-staff Edge Function (one auth
// user + one shop_members row per call), so there's no batching RPC and
// shouldn't be one. Rows are processed sequentially; acceptable since staff
// imports are rare and small compared to customer imports.
export async function runStaffImport(shopId: string, roles: Role[], parsed: ParsedCsv): Promise<ImportReport<StaffMember>> {
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

    try {
      const created = await provisionStaff({ shopId, fullName, email, password: raw['Password']?.trim() || undefined, roleId: role.id });
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
        payType: null,
        payRateCents: null,
        // A freshly provisioned member has no roster row to read a cadence
        // from yet; 'monthly' matches the shop_members column default.
        payCadence: 'monthly',
      });
    } catch (err) {
      reject(err instanceof Error ? err.message : 'Could not add this staff member.');
    }
  }

  return { accepted, rejected };
}
