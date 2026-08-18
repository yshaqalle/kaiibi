// An in-memory stand-in for the Supabase client, good enough to run the CSV
// imports end to end under Jest.
//
// It sits at the SAME boundary the real client does -- `@/lib/supabase` -- so
// everything above it is the app's own code: products.ts's toRow/mapProductRow,
// customers.ts, staff.ts, shifts.ts, and the import modules themselves. That is
// the point. A test that mocked `createProducts` would prove the parser parsed;
// this one proves a row written by an import is the row a screen's list query
// reads back, field mapping included.
//
// What it is NOT: a Postgres. There is no RLS, no trigger, no constraint. The
// three server-side behaviours the imports actually depend on -- complete_sale,
// list_shop_staff and the provision-staff Edge Function -- are hand-written
// below and marked as such.

type Row = Record<string, any>;
type Filter = { op: 'eq' | 'gte' | 'lte'; column: string; value: any };
type Sort = { column: string; ascending: boolean };

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${String(++counter).padStart(4, '0')}`;
// Distinct and increasing, so `.order('created_at')` has something real to sort
// by -- Date.now() ties when two rows are inserted in the same millisecond,
// which is exactly what a bulk import does.
const nextTimestamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, counter++)).toISOString();

// Child tables named in a select string, e.g.
// `'*, sale_items(*), sale_payments(*)'` -> ['sale_items', 'sale_payments'].
function embeddedTables(select: string): string[] {
  return [...select.matchAll(/([a-z_]+)\s*\(/g)].map((m) => m[1]);
}

// products -> product_id, sales -> sale_id. PostgREST infers the join from the
// foreign key; here the naming convention stands in for it, which holds for
// every embed these imports touch.
function foreignKeyOf(parentTable: string): string {
  return `${parentTable.replace(/s$/, '')}_id`;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ op, column, value }) => {
    const cell = row[column];
    if (op === 'eq') return cell === value;
    if (op === 'gte') return cell >= value;
    return cell <= value;
  });
}

function sortRows(rows: Row[], sorts: Sort[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of sorts) {
      const left = a[column];
      const right = b[column];
      if (left === right) continue;
      const order = left > right ? 1 : -1;
      return ascending ? order : -order;
    }
    return 0;
  });
}

class FakeQuery implements PromiseLike<{ data: any; error: any; count?: number }> {
  private filters: Filter[] = [];
  private sorts: Sort[] = [];
  private selectClause: string | null = null;
  private rowLimit: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private singleMode: 'single' | 'maybeSingle' | null = null;

  constructor(
    private readonly db: Record<string, Row[]>,
    private readonly table: string,
    private readonly operation:
      | { kind: 'select' }
      | { kind: 'insert'; rows: Row[] }
      | { kind: 'upsert'; rows: Row[]; conflict: string[]; ignoreDuplicates: boolean }
      | { kind: 'update'; patch: Row }
      | { kind: 'delete' },
    private readonly failing: Set<string> = new Set()
  ) {}

  select(clause = '*') {
    this.selectClause = clause;
    return this;
  }
  eq(column: string, value: any) {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }
  gte(column: string, value: any) {
    this.filters.push({ op: 'gte', column, value });
    return this;
  }
  lte(column: string, value: any) {
    this.filters.push({ op: 'lte', column, value });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.sorts.push({ column, ascending: options?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.rowLimit = n;
    return this;
  }
  // PostgREST's `.range(from, to)` is INCLUSIVE at both ends, so a page of 500
  // is range(0, 499). Callers page until a short page comes back, which is how
  // they know they have reached the end -- modelling the bounds loosely here
  // would make that loop either stop early or never stop.
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  single() {
    this.singleMode = 'single';
    return this;
  }
  maybeSingle() {
    this.singleMode = 'maybeSingle';
    return this;
  }

  private table_(): Row[] {
    this.db[this.table] ??= [];
    return this.db[this.table];
  }

  private withEmbeds(rows: Row[]): Row[] {
    const children = this.selectClause ? embeddedTables(this.selectClause) : [];
    if (children.length === 0) return rows;
    const fk = foreignKeyOf(this.table);
    return rows.map((row) => ({
      ...row,
      ...Object.fromEntries(children.map((child) => [child, (this.db[child] ?? []).filter((c) => c[fk] === row.id)])),
    }));
  }

  private run(): { data: any; error: any; count?: number } {
    const rows = this.table_();

    // Standing in for anything the server can refuse -- RLS, a constraint, a
    // dropped connection. The shape is PostgREST's: a {message} object on
    // `error`, never a thrown exception, which is what callers have to handle.
    if (this.failing.has(this.table)) {
      return { data: null, error: { message: `fake-supabase: "${this.table}" is set to fail` } };
    }

    // `onConflict` names the columns of a unique index, so a row matching an
    // existing one on ALL of them is the conflict. `ignoreDuplicates` is the
    // `do nothing` half of the statement; without it the existing row is
    // overwritten, which is what every non-ignoring caller means by upsert.
    if (this.operation.kind === 'upsert') {
      const { conflict, ignoreDuplicates } = this.operation;
      const inserted: Row[] = [];
      for (const row of this.operation.rows) {
        const existing = conflict.length > 0 ? rows.find((r) => conflict.every((column) => r[column] === row[column])) : undefined;
        if (existing) {
          if (!ignoreDuplicates) Object.assign(existing, row);
          continue;
        }
        const fresh = { id: nextId(this.table), created_at: nextTimestamp(), ...row };
        rows.push(fresh);
        inserted.push(fresh);
      }
      const data = this.selectClause ? this.withEmbeds(inserted) : null;
      return { data: this.singleMode ? (data?.[0] ?? null) : data, error: null };
    }

    if (this.operation.kind === 'insert') {
      const inserted = this.operation.rows.map((row) => ({ id: nextId(this.table), created_at: nextTimestamp(), ...row }));
      rows.push(...inserted);
      const data = this.selectClause ? this.withEmbeds(inserted) : null;
      return { data: this.singleMode ? (data?.[0] ?? null) : data, error: null };
    }

    const hits = rows.filter((row) => matches(row, this.filters));

    if (this.operation.kind === 'update') {
      for (const row of hits) Object.assign(row, this.operation.patch);
      return { data: null, error: null, count: hits.length };
    }
    if (this.operation.kind === 'delete') {
      for (const row of hits) rows.splice(rows.indexOf(row), 1);
      return { data: null, error: null, count: hits.length };
    }

    let data = this.withEmbeds(sortRows(hits, this.sorts));
    if (this.rowLimit !== null) data = data.slice(0, this.rowLimit);
    if (this.rangeFrom !== null && this.rangeTo !== null) data = data.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.singleMode) {
      if (data.length === 1) return { data: data[0], error: null };
      if (this.singleMode === 'maybeSingle' && data.length === 0) return { data: null, error: null };
      return { data: null, error: { message: `expected exactly one row, got ${data.length}` } };
    }
    return { data, error: null, count: data.length };
  }

  then<R1 = any, R2 = never>(
    onFulfilled?: ((value: { data: any; error: any; count?: number }) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: any) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

export type FakeSupabase = {
  client: any;
  db: Record<string, Row[]>;
  seedProduct: (product: Partial<Row> & { shop_id: string; name: string; price_cents: number }) => Row;
  seedRole: (role: { id: string; shop_id: string; name: string }) => Row;
  // Makes every write and read of one table come back with an error, for the
  // tests that care what a caller does when a secondary write fails.
  failTable: (name: string) => void;
  reset: () => void;
};

export function createFakeSupabase(): FakeSupabase {
  const db: Record<string, Row[]> = {};
  const failing = new Set<string>();
  const tableOf = (name: string) => (db[name] ??= []);

  // --- Server-side behaviour, reimplemented ------------------------------
  //
  // `complete_sale` is the RPC the POS uses and the sales import deliberately
  // reuses, so the import's contract with it -- rows in, stock down, one sale
  // id back, nothing partially applied on failure -- is what's modelled here.
  const completeSale = (params: Row) => {
    const products = tableOf('products');
    const items = params.p_items as { product_id: string; quantity: number; discount_cents: number }[];

    for (const item of items) {
      const product = products.find((p) => p.id === item.product_id);
      if (!product) return { data: null, error: { message: `product ${item.product_id} not found` } };
      if (product.stock < item.quantity) {
        return { data: null, error: { message: `Not enough stock for ${product.name}.` } };
      }
    }

    const payments = params.p_payments as { method: string; amount_cents: number }[];
    const totalCents = payments.reduce((sum, p) => sum + p.amount_cents, 0);
    const saleId = nextId('sale');
    let discountCents = 0;
    let itemCount = 0;

    for (const item of items) {
      const product = products.find((p) => p.id === item.product_id)!;
      // The real RPC decrements through the per-location stock trigger; the
      // shop-wide rollup is what the import and its test can observe.
      product.stock -= item.quantity;
      discountCents += item.discount_cents;
      itemCount += item.quantity;
      tableOf('sale_items').push({
        id: nextId('sale-item'),
        sale_id: saleId,
        product_id: product.id,
        product_name: product.name,
        unit_price_cents: product.price_cents,
        quantity: item.quantity,
        line_total_cents: product.price_cents * item.quantity - item.discount_cents,
        discount_cents: item.discount_cents,
      });
    }

    for (const payment of payments) {
      tableOf('sale_payments').push({
        id: nextId('sale-payment'),
        sale_id: saleId,
        method: payment.method,
        amount_cents: payment.amount_cents,
        created_at: nextTimestamp(),
      });
    }

    tableOf('sales').push({
      id: saleId,
      shop_id: params.p_shop_id,
      location_id: null,
      payment_method: payments[0]?.method ?? null,
      customer_name: params.p_customer_name,
      customer_phone: params.p_customer_phone,
      customer_email: params.p_customer_email,
      discount_cents: discountCents,
      tax_cents: 0,
      total_cents: totalCents,
      item_count: itemCount,
      created_at: params.p_created_at ?? nextTimestamp(),
    });

    return { data: saleId, error: null };
  };

  // `list_shop_staff` flattens the role name and location ids onto each row --
  // the shape mapStaffRow expects from the RPC (as opposed to the embedded
  // shape it also accepts from a direct select).
  const listShopStaff = (params: Row) => ({
    data: tableOf('shop_members')
      .filter((member) => member.shop_id === params.p_shop_id)
      .map((member) => ({
        ...member,
        role_name: tableOf('roles').find((role) => role.id === member.role_id)?.name ?? '',
        location_ids: tableOf('shop_member_locations')
          .filter((link) => link.shop_member_id === member.id)
          .map((link) => link.location_id),
      })),
    error: null,
  });

  const rpcHandlers: Record<string, (params: Row) => { data: any; error: any }> = {
    complete_sale: completeSale,
    list_shop_staff: listShopStaff,
  };

  // The provision-staff Edge Function mints an auth user and a shop_members
  // row in one call. Only the duplicate-email refusal matters to an import --
  // it's what a re-run of the same file hits.
  const provisionStaff = (body: Row) => {
    const members = tableOf('shop_members');
    const email = String(body.email).trim().toLowerCase();
    if (members.some((m) => (m.email ?? '').toLowerCase() === email)) {
      return { data: { error: 'duplicate_email', message: 'That email already belongs to a team member.' }, error: null };
    }
    const userId = nextId('user');
    const member = {
      id: nextId('member'),
      shop_id: body.shopId,
      user_id: userId,
      role_id: body.roleId,
      active: true,
      full_name: body.fullName,
      email,
      phone: body.phone ?? null,
      photo_url: null,
      created_at: nextTimestamp(),
      hire_date: null,
      pay_type: null,
      pay_rate_cents: null,
      pay_cadence: 'monthly',
    };
    members.push(member);
    return {
      data: {
        userId,
        email,
        temporaryPassword: body.password ? null : 'temp-password',
        member: { id: member.id, shopId: member.shop_id, userId, roleId: member.role_id, active: true },
      },
      error: null,
    };
  };

  const client = {
    from: (table: string) => ({
      select: (clause = '*') => new FakeQuery(db, table, { kind: 'select' }, failing).select(clause),
      insert: (rows: Row | Row[]) =>
        new FakeQuery(db, table, { kind: 'insert', rows: Array.isArray(rows) ? rows : [rows] }, failing),
      upsert: (rows: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) =>
        new FakeQuery(
          db,
          table,
          {
            kind: 'upsert',
            rows: Array.isArray(rows) ? rows : [rows],
            conflict: (options?.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean),
            ignoreDuplicates: options?.ignoreDuplicates === true,
          },
          failing
        ),
      update: (patch: Row) => new FakeQuery(db, table, { kind: 'update', patch }, failing),
      delete: () => new FakeQuery(db, table, { kind: 'delete' }, failing),
    }),
    rpc: async (name: string, params: Row = {}) => {
      const handler = rpcHandlers[name];
      if (!handler) throw new Error(`fake-supabase: no handler for rpc "${name}"`);
      return handler(params);
    },
    auth: {
      getUser: async () => ({ data: { user: { id: 'test-user' } }, error: null }),
    },
    functions: {
      invoke: async (name: string, options: { body: Row }) => {
        if (name !== 'provision-staff') throw new Error(`fake-supabase: no handler for function "${name}"`);
        return provisionStaff(options.body);
      },
    },
  };

  return {
    client,
    db,
    seedProduct: (product) => {
      const row = {
        id: nextId('product'),
        created_at: nextTimestamp(),
        sku: null,
        barcode: null,
        tags: [],
        cost_cents: null,
        stock: 0,
        reorder_level: null,
        ...product,
      };
      tableOf('products').push(row);
      return row;
    },
    seedRole: (role) => {
      const row = { ...role, permissions: [] };
      tableOf('roles').push(row);
      return row;
    },
    failTable: (name) => {
      failing.add(name);
    },
    reset: () => {
      for (const key of Object.keys(db)) delete db[key];
      failing.clear();
    },
  };
}
