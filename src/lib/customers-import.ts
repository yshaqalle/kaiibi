import { createCustomers, listCustomers } from '@/lib/customers';
import type { ParsedCsv } from '@/lib/csv';
import type { ImportReport, RejectedRow } from '@/lib/import-shared';
import type { Customer, NewCustomerInput } from '@/types/models';

export const CUSTOMERS_TEMPLATE_COLUMNS: { header: string; required: boolean }[] = [
  { header: 'First Name', required: true },
  { header: 'Last Name', required: false },
  { header: 'Email', required: false },
  { header: 'Phone', required: false },
  { header: 'Street', required: false },
  { header: 'City', required: false },
  { header: 'Neighborhood', required: false },
  { header: 'Tags', required: false },
];

export const CUSTOMERS_EXAMPLE_ROW: Record<string, string> = {
  'First Name': 'Amina',
  'Last Name': 'Hassan',
  Email: 'amina@example.com',
  Phone: '+252634000000',
  Street: 'Airport Road',
  City: 'Hargeisa',
  Neighborhood: 'Jigjiga Yar',
  Tags: 'vip',
};

function fullNameKey(first: string, last: string | null): string {
  return `${first} ${last ?? ''}`.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Any existing customer with the same name blocks the row -- as an exact
// duplicate if phone or email also matches, or as an ambiguous name
// conflict if neither does. Only genuinely new names get created; the
// import never merges or updates an existing record.
export async function runCustomersImport(shopId: string, parsed: ParsedCsv): Promise<ImportReport<Customer>> {
  const existing = await listCustomers(shopId);
  const existingByName = new Map<string, Customer[]>();
  for (const c of existing) {
    const key = fullNameKey(c.firstName, c.lastName);
    existingByName.set(key, [...(existingByName.get(key) ?? []), c]);
  }

  const rejected: RejectedRow[] = [];
  const toCreate: NewCustomerInput[] = [];
  const seenNames = new Set<string>();

  parsed.rows.forEach((raw, i) => {
    const row = i + 2; // header occupies row 1 in the uploaded file
    const reject = (reason: string) => rejected.push({ row, reason, data: raw });

    const firstName = raw['First Name']?.trim();
    if (!firstName) return reject('First Name is required.');

    const lastName = raw['Last Name']?.trim() || null;
    const email = raw['Email']?.trim() || null;
    const phone = raw['Phone']?.trim() || null;
    const nameKey = fullNameKey(firstName, lastName);

    const matches = existingByName.get(nameKey);
    if (matches) {
      const exact = matches.some((c) => (email && c.email?.toLowerCase() === email.toLowerCase()) || (phone && c.phone === phone));
      return reject(
        exact
          ? `A customer named "${firstName}${lastName ? ` ${lastName}` : ''}" already exists — edit them in Customers instead of importing.`
          : `A customer named "${firstName}${lastName ? ` ${lastName}` : ''}" already exists with different contact info — review manually before importing.`
      );
    }
    if (seenNames.has(nameKey)) return reject('Duplicate of an earlier row in this file.');
    seenNames.add(nameKey);

    toCreate.push({
      firstName,
      lastName,
      email,
      phone,
      street: raw['Street']?.trim() || null,
      city: raw['City']?.trim() || null,
      neighborhood: raw['Neighborhood']?.trim() || null,
      tags: (raw['Tags'] ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean),
      notes: null,
    });
  });

  const accepted = toCreate.length > 0 ? await createCustomers(shopId, toCreate) : [];
  return { accepted, rejected };
}
