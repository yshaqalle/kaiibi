// Round-trips every CSV import the app offers: generate the template the
// "Download example CSV" button hands out, feed those exact bytes back through
// the picker's parse-and-validate path, run the import, and then read the data
// back with the SAME query the screen uses -- so "it imported" means "it is in
// the list", not "the function returned an array".
//
// Everything above `@/lib/supabase` is real app code (products.ts, customers.ts,
// staff.ts, shifts.ts and the five import modules). Only the client is faked;
// see jest/fake-supabase.ts for what that does and does not model.

import { listBrands } from '@/lib/brands';
import { listCategories } from '@/lib/categories';
import { parseCsvText, rowsToCsv, type ParsedCsv } from '@/lib/csv';
import { listCustomers } from '@/lib/customers';
import { CUSTOMERS_EXAMPLE_ROW, CUSTOMERS_TEMPLATE_COLUMNS, runCustomersImport } from '@/lib/customers-import';
import { missingRequiredColumns, templateCsvText, type TemplateColumn } from '@/lib/import-shared';
import { listProducts } from '@/lib/products';
import { PRODUCTS_EXAMPLE_ROWS, PRODUCTS_TEMPLATE_COLUMNS, runProductsImport } from '@/lib/products-import';
import { runSalesImport, SALES_EXAMPLE_ROWS, SALES_TEMPLATE_COLUMNS } from '@/lib/sales-import';
import { listSales } from '@/lib/sales';
import { SCHEDULE_EXAMPLE_ROWS, SCHEDULE_TEMPLATE_COLUMNS, scheduleTemplateRows } from '@/lib/schedule-import';
import { listShiftsForWeek, runScheduleImport } from '@/lib/shifts';
import { listStaff } from '@/lib/staff';
import { TEAM_EXPORT_COLUMNS_WITH_PAY } from '@/lib/staff-export';
import { runStaffImport, STAFF_EXAMPLE_ROW, STAFF_TEMPLATE_COLUMNS } from '@/lib/staff-import';
import { listTags } from '@/lib/tags';
import type { FakeSupabase } from '../../../jest/fake-supabase';
import type { Role, Shop, ShopLocation, StaffMember } from '@/types/models';

// Hoisted above the imports above by babel-plugin-jest-hoist, so the modules
// under test pick up the fake client rather than the real one. The factory has
// to `require` its own dependency: it runs before the import bindings exist.
jest.mock('@/lib/supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createFakeSupabase } = require('../../../jest/fake-supabase');
  const fake = createFakeSupabase();
  return { supabase: fake.client, __fake: fake };
});

const { __fake: fake } = jest.requireMock('@/lib/supabase') as { __fake: FakeSupabase };

const SHOP_ID = 'shop-under-test';
const SHOP = { id: SHOP_ID, taxEnabled: false, taxRatePercent: 0 } as Shop;

// The user's half of the round trip: download the template, open it, upload it.
// `templateCsvText` is what the download button writes and `parseCsvText` is
// what the picker reads, so the only thing standing in for a person here is the
// file never touching disk.
function downloadThenUpload(templateColumns: TemplateColumn[], exampleRows: Record<string, string>[]): ParsedCsv {
  const csvText = templateCsvText(templateColumns, exampleRows);
  const parsed = parseCsvText(csvText);
  // The picker refuses a file before importing it if a required column is
  // absent -- a template that can't clear its own gate is the first thing worth
  // knowing, so it's asserted on every entity rather than tested once.
  expect(missingRequiredColumns(templateColumns, parsed.headers)).toEqual([]);
  expect(parsed.rows.length).toBe(exampleRows.length);
  return parsed;
}

beforeEach(() => {
  fake.reset();
});

describe('products import', () => {
  it('imports the downloaded template and the products appear in Inventory', async () => {
    const parsed = downloadThenUpload(PRODUCTS_TEMPLATE_COLUMNS, PRODUCTS_EXAMPLE_ROWS);

    const report = await runProductsImport(SHOP_ID, parsed);
    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(2);

    const inventory = await listProducts(SHOP_ID);
    expect(inventory.map((p) => p.name).sort()).toEqual(['Blue Cotton T-Shirt', 'Wool Scarf']);

    const imported = inventory.find((p) => p.name === 'Blue Cotton T-Shirt');
    expect(imported).toBeDefined();
    // Every column the template fills, read back through the list query -- the
    // dollars-to-cents conversion and the tags split are where a round trip
    // silently loses data.
    expect(imported).toMatchObject({
      sku: 'TSHIRT-BLU-M',
      barcode: '012345678905',
      brand: 'Acme',
      category: 'Apparel',
      tags: ['summer', 'bestseller'],
      supplierName: 'Acme Wholesale',
      costCents: 450,
      priceCents: 1299,
      stock: 25,
      reorderLevel: 5,
      shelfNumber: 'A3',
    });

    // The scarf fills only the required columns, so it is also the check that
    // every optional column left blank comes back as absent rather than as an
    // empty string or a zero.
    expect(inventory.find((p) => p.name === 'Wool Scarf')).toMatchObject({
      sku: 'SCARF-WOOL',
      priceCents: 800,
      stock: 10,
      barcode: null,
      brand: null,
      supplierName: null,
      costCents: null,
      reorderLevel: null,
      tags: [],
    });
  });

  // The bug this covers: an imported category was written to `products.category`
  // as free text and never given a row in `categories`, so POS -- which builds
  // its filter row from listCategories(), not from the products -- had no chip
  // for it. A shop that imported its whole catalogue saw only the handful of
  // categories it had typed by hand, which read as "categories are capped".
  //
  // Asserted through the same list queries the screens call, so "registered"
  // means "POS would draw a chip for it", not "an upsert was attempted".
  it('registers the categories, brands and tags it imported, so POS can filter by them', async () => {
    const parsed = downloadThenUpload(PRODUCTS_TEMPLATE_COLUMNS, PRODUCTS_EXAMPLE_ROWS);
    await runProductsImport(SHOP_ID, parsed);

    expect((await listCategories(SHOP_ID)).map((c) => c.name)).toEqual(['Apparel']);
    expect((await listBrands(SHOP_ID)).map((b) => b.name)).toEqual(['Acme']);
    expect((await listTags(SHOP_ID)).map((t) => t.name).sort()).toEqual(['bestseller', 'summer']);
  });

  // Both template rows are 'Apparel'. One row, not two -- the shop-wide list
  // has to stay a list of distinct names however many products carry each one.
  it('registers a category once however many rows carry it', async () => {
    await runProductsImport(SHOP_ID, downloadThenUpload(PRODUCTS_TEMPLATE_COLUMNS, PRODUCTS_EXAMPLE_ROWS));
    expect(await listCategories(SHOP_ID)).toHaveLength(1);
  });

  // A rejected row's category must not be registered: the product it came from
  // does not exist, so a chip for it would filter to nothing.
  it('does not register the category of a row it rejected', async () => {
    const parsed = parseCsvText(
      templateCsvText(PRODUCTS_TEMPLATE_COLUMNS, [
        { ...PRODUCTS_EXAMPLE_ROWS[0], Name: 'Rejected Row', Category: 'Ghost Category', Price: '' },
      ])
    );
    const report = await runProductsImport(SHOP_ID, parsed);

    expect(report.accepted).toEqual([]);
    expect(report.rejected).toHaveLength(1);
    expect(await listCategories(SHOP_ID)).toEqual([]);
  });

  // Registering the names must never cost the shop its import. The products are
  // already inserted by the time this runs, so a failure here is cosmetic --
  // the chips are missing, which is recoverable, whereas a thrown error would
  // report a successful import as a failure and invite a duplicate re-upload.
  it('still reports the import when registering the names fails', async () => {
    const parsed = downloadThenUpload(PRODUCTS_TEMPLATE_COLUMNS, PRODUCTS_EXAMPLE_ROWS);
    fake.failTable('categories');

    const report = await runProductsImport(SHOP_ID, parsed);

    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(2);
    expect(await listProducts(SHOP_ID)).toHaveLength(2);
  });

  it('rejects the same template on a second import, since the products are now there', async () => {
    const first = downloadThenUpload(PRODUCTS_TEMPLATE_COLUMNS, PRODUCTS_EXAMPLE_ROWS);
    await runProductsImport(SHOP_ID, first);

    const second = await runProductsImport(SHOP_ID, downloadThenUpload(PRODUCTS_TEMPLATE_COLUMNS, PRODUCTS_EXAMPLE_ROWS));
    expect(second.accepted).toEqual([]);
    expect(second.rejected).toHaveLength(2);
    expect(second.rejected[0].reason).toMatch(/Restock/);
    expect(await listProducts(SHOP_ID)).toHaveLength(2);
  });
});

describe('customers import', () => {
  it('imports the downloaded template and the customer appears in People', async () => {
    const parsed = downloadThenUpload(CUSTOMERS_TEMPLATE_COLUMNS, [CUSTOMERS_EXAMPLE_ROW]);

    const report = await runCustomersImport(SHOP_ID, parsed);
    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(1);

    const customers = await listCustomers(SHOP_ID);
    expect(customers.find((c) => c.firstName === 'Amina')).toMatchObject({
      lastName: 'Hassan',
      email: 'amina@example.com',
      phone: '+252634000000',
      street: 'Airport Road',
      city: 'Hargeisa',
      neighborhood: 'Jigjiga Yar',
      tags: ['vip'],
    });
  });

  it('rejects the same template on a second import, since the customer is now there', async () => {
    await runCustomersImport(SHOP_ID, downloadThenUpload(CUSTOMERS_TEMPLATE_COLUMNS, [CUSTOMERS_EXAMPLE_ROW]));

    const second = await runCustomersImport(SHOP_ID, downloadThenUpload(CUSTOMERS_TEMPLATE_COLUMNS, [CUSTOMERS_EXAMPLE_ROW]));
    expect(second.accepted).toEqual([]);
    expect(second.rejected[0].reason).toMatch(/already exists/);
    expect(await listCustomers(SHOP_ID)).toHaveLength(1);
  });
});

describe('staff import', () => {
  const cashierRole = { id: 'role-cashier', shopId: SHOP_ID, name: 'Cashier', permissions: [] } as unknown as Role;

  beforeEach(() => {
    fake.seedRole({ id: cashierRole.id, shop_id: SHOP_ID, name: 'Cashier' });
  });

  it('imports the downloaded template and the member appears on the team', async () => {
    const parsed = downloadThenUpload(STAFF_TEMPLATE_COLUMNS, [STAFF_EXAMPLE_ROW]);

    const report = await runStaffImport(SHOP_ID, [cashierRole], parsed, true);
    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(1);

    const team = await listStaff(SHOP_ID);
    expect(team.find((m) => m.email === 'hamse@example.com')).toMatchObject({
      fullName: 'Hamse Jibril',
      roleName: 'Cashier',
      phone: '063 400 0000',
      active: true,
      // The template carries no pay columns, so an imported member starts with
      // no pay set rather than a guessed one.
      payType: null,
      payRateCents: null,
      payCadence: 'monthly',
    });
  });

  it('rejects a row whose role is not one the shop has', async () => {
    const parsed = downloadThenUpload(STAFF_TEMPLATE_COLUMNS, [{ ...STAFF_EXAMPLE_ROW, Role: 'Sorcerer' }]);

    const report = await runStaffImport(SHOP_ID, [cashierRole], parsed, true);
    expect(report.accepted).toEqual([]);
    expect(report.rejected[0].reason).toMatch(/does not match an existing role/);
    expect(await listStaff(SHOP_ID)).toEqual([]);
  });

  it('rejects the same template on a second import, since the member now exists', async () => {
    await runStaffImport(SHOP_ID, [cashierRole], downloadThenUpload(STAFF_TEMPLATE_COLUMNS, [STAFF_EXAMPLE_ROW]), true);

    const second = await runStaffImport(SHOP_ID, [cashierRole], downloadThenUpload(STAFF_TEMPLATE_COLUMNS, [STAFF_EXAMPLE_ROW]), true);
    expect(second.accepted).toEqual([]);
    expect(second.rejected).toHaveLength(1);
    expect(await listStaff(SHOP_ID)).toHaveLength(1);
  });

  // The other round trip: not the blank template, but a roster this app
  // exported. Moving a team between shops is the real reason to do it, so the
  // import runs against a second shop rather than the one exported from.
  //
  // This is the test the 'Name'-vs-'Full Name' mismatch would have failed: the
  // exported file could not clear the picker's required-column gate at all.
  it('re-imports a team roster the app itself exported, pay included', async () => {
    const exported: StaffMember[] = [
      {
        id: 'member-hodan',
        shopId: SHOP_ID,
        userId: 'user-hodan',
        roleId: cashierRole.id,
        roleName: 'Cashier',
        locationIds: [],
        active: true,
        fullName: 'Hodan Ali',
        email: 'hodan@example.com',
        phone: '063 400 1111',
        photoUrl: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        hireDate: '2026-02-01',
        payType: 'hourly',
        payRateCents: 1250,
        payCadence: 'weekly',
      },
    ];

    const csvText = rowsToCsv(exported, TEAM_EXPORT_COLUMNS_WITH_PAY);
    const parsed = parseCsvText(csvText);
    expect(missingRequiredColumns(STAFF_TEMPLATE_COLUMNS, parsed.headers)).toEqual([]);

    const OTHER_SHOP = 'shop-receiving-the-roster';
    const otherRole = { id: 'role-cashier-2', shopId: OTHER_SHOP, name: 'Cashier', permissions: [] } as unknown as Role;
    fake.seedRole({ id: otherRole.id, shop_id: OTHER_SHOP, name: 'Cashier' });

    const report = await runStaffImport(OTHER_SHOP, [otherRole], parsed, true);
    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(1);

    const team = await listStaff(OTHER_SHOP);
    expect(team.find((m) => m.email === 'hodan@example.com')).toMatchObject({
      fullName: 'Hodan Ali',
      roleName: 'Cashier',
      phone: '063 400 1111',
      // The pay columns survive the trip out and back -- which is what the
      // exported 'Pay Rate Unit' column exists to make possible, since "$12.50"
      // alone can't say per what.
      payType: 'hourly',
      payRateCents: 1250,
      payCadence: 'weekly',
    });
  });
});

describe('sales import', () => {
  // The sales template sells one product by SKU and one by name, and BOTH are
  // products the products template creates -- nothing here is hand-seeded. That
  // is the whole point: a shop that downloads every template and imports them
  // in order gets a working demo, so this runs the products template's output
  // straight into the sales template's input.
  async function importTheProductsTemplate() {
    const report = await runProductsImport(SHOP_ID, downloadThenUpload(PRODUCTS_TEMPLATE_COLUMNS, PRODUCTS_EXAMPLE_ROWS));
    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(2);
  }

  it('imports the downloaded template and the sale appears in Transactions', async () => {
    await importTheProductsTemplate();
    const parsed = downloadThenUpload(SALES_TEMPLATE_COLUMNS, SALES_EXAMPLE_ROWS);

    const report = await runSalesImport(SHOP, parsed);
    expect(report.rejected).toEqual([]);
    // Two rows, one Sale Reference: one sale, not two.
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0].saleReference).toBe('SALE-1001');
    // 2 x 12.99 plus 8.00 less a 1.00 discount, no tax on this shop.
    expect(report.accepted[0].totalCents).toBe(3298);

    const sales = await listSales(SHOP_ID);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ customerName: 'Amina Hassan', customerPhone: '+252634000000', paymentMethod: 'cash', totalCents: 3298 });
    expect((sales[0].items ?? []).map((i) => `${i.quantity}x ${i.productName}`).sort()).toEqual(['1x Wool Scarf', '2x Blue Cotton T-Shirt']);
    expect(new Date(sales[0].createdAt).toISOString().slice(0, 10)).toBe('2026-06-14');

    // An imported sale has to move stock exactly like a checkout does, or the
    // catalog quietly drifts from the takings.
    const inventory = await listProducts(SHOP_ID);
    expect(inventory.find((p) => p.sku === 'TSHIRT-BLU-M')!.stock).toBe(23);
    expect(inventory.find((p) => p.sku === 'SCARF-WOOL')!.stock).toBe(9);
  });

  it('rejects the whole sale, and writes nothing, when one line has no matching product', async () => {
    await importTheProductsTemplate();
    const rows = SALES_EXAMPLE_ROWS.map((row) => ({ ...row }));
    rows[1] = { ...rows[1], 'Product Name': 'Something We Do Not Sell' };
    const parsed = downloadThenUpload(SALES_TEMPLATE_COLUMNS, rows);

    const report = await runSalesImport(SHOP, parsed);
    expect(report.accepted).toEqual([]);
    // Both rows of the group are reported, so the user can see the whole sale
    // was refused rather than half-applied.
    expect(report.rejected).toHaveLength(2);
    expect(report.rejected[0].reason).toMatch(/Product not found/);
    expect(await listSales(SHOP_ID)).toEqual([]);
    expect((await listProducts(SHOP_ID)).find((p) => p.sku === 'TSHIRT-BLU-M')!.stock).toBe(25);
  });
});

describe('schedule import', () => {
  const member = {
    id: 'member-hamse',
    shopId: SHOP_ID,
    userId: 'user-hamse',
    roleId: 'role-cashier',
    roleName: 'Cashier',
    locationIds: [],
    active: true,
    fullName: 'Hamse Jibril',
    email: 'hamse@example.com',
    phone: null,
    photoUrl: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    hireDate: null,
    payType: null,
    payRateCents: null,
    payCadence: 'monthly',
  } as StaffMember;
  const mainStore = { id: 'location-main', shopId: SHOP_ID, name: 'Main', isPrimary: true, active: true } as ShopLocation;
  const context = { members: [member], locations: [mainStore] };
  // The template's three rows all fall in the week beginning Monday 2026-08-10.
  const WEEK = '2026-08-10';

  it('imports the downloaded template and the shifts appear on the week', async () => {
    const parsed = downloadThenUpload(SCHEDULE_TEMPLATE_COLUMNS, SCHEDULE_EXAMPLE_ROWS);

    const report = await runScheduleImport(SHOP_ID, parsed, context);
    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(3);

    const week = await listShiftsForWeek(SHOP_ID, WEEK);
    expect(week.map((s) => `${s.date} ${s.start}-${s.end}`)).toEqual([
      '2026-08-10 09:00-17:00',
      // The split day survives as two rows, which is what lets an exported
      // week be re-imported unchanged.
      '2026-08-11 09:00-13:00',
      '2026-08-11 17:00-21:00',
    ]);
    expect(week.every((s) => s.shopMemberId === member.id && s.locationId === mainStore.id)).toBe(true);
    expect(week.find((s) => s.start === '17:00')!.note).toBe('evening');
  });

  it('rejects the same template on a second import, since those shifts are now on the rota', async () => {
    await runScheduleImport(SHOP_ID, downloadThenUpload(SCHEDULE_TEMPLATE_COLUMNS, SCHEDULE_EXAMPLE_ROWS), context);

    const second = await runScheduleImport(SHOP_ID, downloadThenUpload(SCHEDULE_TEMPLATE_COLUMNS, SCHEDULE_EXAMPLE_ROWS), context);
    expect(second.accepted).toEqual([]);
    expect(second.rejected).toHaveLength(3);
    expect(second.rejected[0].reason).toMatch(/already has a shift overlapping/);
    expect(await listShiftsForWeek(SHOP_ID, WEEK)).toHaveLength(3);
  });

  // The template a manager is actually handed: their own people against the
  // week on screen, dates and store already written in. They type times on the
  // days someone works and upload it untouched otherwise -- so the blank days
  // have to survive the round trip as nothing at all, not as five rejections.
  it('imports a pre-filled week template with only some days filled in', async () => {
    const week = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
    const filled = scheduleTemplateRows([member], week, { locationId: mainStore.id, locations: [mainStore] }).map((row) =>
      row.Date === '2026-08-10' || row.Date === '2026-08-12' ? { ...row, Start: '09:00', End: '17:00' } : row
    );

    const parsed = downloadThenUpload(SCHEDULE_TEMPLATE_COLUMNS, filled);
    expect(parsed.rows).toHaveLength(5);

    const report = await runScheduleImport(SHOP_ID, parsed, context);
    expect(report.rejected).toEqual([]);
    expect(report.accepted).toHaveLength(2);

    const rota = await listShiftsForWeek(SHOP_ID, WEEK);
    expect(rota.map((s) => s.date)).toEqual(['2026-08-10', '2026-08-12']);
    expect(rota.every((s) => s.shopMemberId === member.id && s.locationId === mainStore.id)).toBe(true);
  });
});
