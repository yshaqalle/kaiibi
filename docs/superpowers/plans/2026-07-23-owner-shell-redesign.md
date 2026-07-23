# Owner Shell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ka Iibi's owner web top-nav with a left sidebar and restyle all four owner screens (Dashboard, POS, Inventory, Sales) onto a shared, fully monochrome visual language, per `docs/superpowers/specs/2026-07-23-owner-shell-redesign-design.md`.

**Architecture:** Small shared presentational primitives (`Card`, `CategoryChip`, `StatTile`, `PaymentMethodPicker`, a restyled `ProductTile`) composed into the four existing owner screens. One route rename (`/sell` → `/pos`). One behavior addition: freeform, self-suggesting category/tag entry on the product form, backed by a new pure `product-taxonomy.ts` module. No database schema changes, no changes to `lib/products.ts`/`lib/sales.ts`/`lib/cart.ts` call signatures.

**Tech Stack:** Expo Router (file-based routes), React Native `StyleSheet`, `expo-router/ui` (`Tabs`/`TabList`/`TabTrigger`/`TabSlot`) for the owner tab/sidebar shell, Jest (`jest-expo` preset) for the one new pure-logic test file.

## Global Constraints

- **Color palette (fully monochrome — confirmed explicitly, no exceptions):**
  - Background/surface: `#FFFFFF`
  - Borders: `#ECECEC` (structural, e.g. sidebar divider) / `#EDEDED` (card borders)
  - Primary text: `#111111`
  - Secondary/muted text: `#999999` (labels) / `#777777` (secondary values)
  - Active nav item fill: `#F2F2F2` (light gray, not black)
  - Primary button/badge fill: `#111111` with white text
  - Low-stock warning (kept as functional exception): text `#B5793A`, border `#E8C99B`
  - Out-of-stock badge: solid `#111111` fill, white text (not red)
  - `CategoryChip` inactive state (functional exception, from the approved design spec): border `#E2E2E2`, label text `#444444`. Slightly lighter/darker than the general border/text grays above because it needs to read as an interactive control against plain white, not a static card border — active state still uses `#111111` fill / white text like every other primary control.
  - Ka Iibi's terracotta `#E45B37` must not appear anywhere touched by this plan — including `revenue-chart.tsx`'s bar color (Task 8).
- **Scope: web only.** Native (`owner-tabs.tsx`, `NativeTabs`) keeps its bottom tab bar exactly as laid out today — only its `sell` trigger name and label are renamed to `pos`/"POS" for route consistency (Task 6). No other native visual change.
- **No database schema changes.** `Product.category: string | null` and `Product.tags: string[]` already support arbitrary values — Task 5 only changes how the picker UI populates its suggestions.
- **`PaymentMethod` stays `'cash' | 'zaad' | 'edahab' | 'other'`** (from `src/types/models.ts:1`). No `'card'` value is added.
- **Test convention (follows existing project pattern):** this repo only unit-tests pure logic in `src/lib/**` (see `src/lib/__tests__/cart.test.ts`, `currency.test.ts`) — there is no component-testing setup. Task 1's `product-taxonomy.ts` gets a real TDD cycle. Every other task is presentational RN component/screen work with no branching logic worth a unit test; those tasks end with an explicit manual-verification step (`npm run web`, check the named screen) instead of a test step, matching the design spec's own Testing section.
- Run `npx tsc --noEmit` after every task that touches `.ts`/`.tsx` files — the codebase has no dedicated typecheck script, but `tsconfig.json` is present at the repo root so this works directly.

---

### Task 1: `product-taxonomy.ts` — derive categories/tags from a shop's products

**Files:**
- Create: `src/lib/product-taxonomy.ts`
- Test: `src/lib/__tests__/product-taxonomy.test.ts`

**Interfaces:**
- Consumes: `Product` type from `@/types/models` (already defined — `category: string | null`, `tags: string[]`).
- Produces: `deriveCategories(products: Product[]): string[]` and `deriveTags(products: Product[]): string[]`, both used by Task 5 (`product-form.tsx`) and Task 6 (POS category chips).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/product-taxonomy.test.ts
import { deriveCategories, deriveTags } from '@/lib/product-taxonomy';
import type { Product } from '@/types/models';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1', shopId: 's1', name: 'Toner', description: null, sku: null, barcode: null, brand: null,
    category: null, tags: [], supplierName: null, costCents: null, priceCents: 2400, stock: 10,
    reorderLevel: null, shelfNumber: null, expiryDate: null, batchNumber: null, imageUrl: null,
    isListedOnline: false, createdAt: '', updatedAt: '', ...overrides,
  };
}

describe('deriveCategories', () => {
  it('returns distinct, alphabetically sorted categories', () => {
    const products = [
      makeProduct({ id: 'p1', category: 'Toners' }),
      makeProduct({ id: 'p2', category: 'Serums' }),
      makeProduct({ id: 'p3', category: 'Toners' }),
    ];
    expect(deriveCategories(products)).toEqual(['Serums', 'Toners']);
  });

  it('excludes null and empty-string categories', () => {
    const products = [
      makeProduct({ id: 'p1', category: null }),
      makeProduct({ id: 'p2', category: '' }),
      makeProduct({ id: 'p3', category: 'Masks' }),
    ];
    expect(deriveCategories(products)).toEqual(['Masks']);
  });

  it('returns an empty array for no products', () => {
    expect(deriveCategories([])).toEqual([]);
  });
});

describe('deriveTags', () => {
  it('returns distinct, alphabetically sorted tags flattened across products', () => {
    const products = [
      makeProduct({ id: 'p1', tags: ['bestseller', 'toner'] }),
      makeProduct({ id: 'p2', tags: ['toner', 'sensitive-skin'] }),
    ];
    expect(deriveTags(products)).toEqual(['bestseller', 'sensitive-skin', 'toner']);
  });

  it('excludes empty-string tags', () => {
    const products = [makeProduct({ id: 'p1', tags: ['', 'new'] })];
    expect(deriveTags(products)).toEqual(['new']);
  });

  it('returns an empty array for no products', () => {
    expect(deriveTags([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/lib/__tests__/product-taxonomy.test.ts`
Expected: FAIL — `Cannot find module '@/lib/product-taxonomy'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/product-taxonomy.ts
import type { Product } from '@/types/models';

export function deriveCategories(products: Product[]): string[] {
  const distinct = new Set(products.map((p) => p.category).filter((c): c is string => Boolean(c)));
  return [...distinct].sort((a, b) => a.localeCompare(b));
}

export function deriveTags(products: Product[]): string[] {
  const distinct = new Set(products.flatMap((p) => p.tags).filter((tag): tag is string => Boolean(tag)));
  return [...distinct].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/lib/__tests__/product-taxonomy.test.ts`
Expected: PASS — 6 tests passing

- [ ] **Step 5: Commit**

```bash
git add src/lib/product-taxonomy.ts src/lib/__tests__/product-taxonomy.test.ts
git commit -m "feat: add product-taxonomy for deriving shop categories/tags"
```

---

### Task 2: Shared visual primitives — `Card`, `CategoryChip`, `StatTile`

**Files:**
- Create: `src/components/card.tsx`
- Create: `src/components/category-chip.tsx`
- Create: `src/components/stat-tile.tsx`
- Delete: `src/components/metric-tile.tsx` (fully replaced by `StatTile` — both current call sites are updated in Task 8 and Task 9, not this task; see note below)

**Interfaces:**
- Produces: `Card({ children, style? })`, `CategoryChip({ label, active, onPress })`, `StatTile({ value, label })` — consumed by Task 4 (Inventory), Task 5 (product form), Task 6 (POS), Task 8 (Dashboard), Task 9 (Sales).

Note on `metric-tile.tsx` deletion: `dashboard.tsx` and `sales.tsx` still import `MetricTile` until Task 8/9 run. Deleting it now would break the build. **Do not delete it in this task** — leave `metric-tile.tsx` in place; Task 8 and Task 9 each switch their own file over to `StatTile` and Task 9 (the last consumer) deletes `metric-tile.tsx` once nothing imports it. This task only adds the three new files.

- [ ] **Step 1: Create `Card`**

```typescript
// src/components/card.tsx
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 1, borderColor: '#EDEDED' },
});
```

- [ ] **Step 2: Create `CategoryChip`**

```typescript
// src/components/category-chip.tsx
import { Pressable, StyleSheet, Text } from 'react-native';

export function CategoryChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E2E2', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 16 },
  chipActive: { backgroundColor: '#111111', borderColor: '#111111' },
  chipText: { fontSize: 12, fontWeight: '600', color: '#444444' },
  chipTextActive: { color: '#FFFFFF', fontWeight: '700' },
});
```

- [ ] **Step 3: Create `StatTile`**

```typescript
// src/components/stat-tile.tsx
import { StyleSheet, Text, View } from 'react-native';

export function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, minHeight: 90, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#EDEDED', backgroundColor: '#FFFFFF', justifyContent: 'flex-end' },
  value: { color: '#111111', fontSize: 22, letterSpacing: -1, fontWeight: '800' },
  label: { marginTop: 4, color: '#999999', fontSize: 11, lineHeight: 14 },
});
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (these three files have no consumers yet, so nothing else changes)

- [ ] **Step 5: Commit**

```bash
git add src/components/card.tsx src/components/category-chip.tsx src/components/stat-tile.tsx
git commit -m "feat: add Card, CategoryChip, StatTile shared primitives"
```

---

### Task 3: `PaymentMethodPicker`

**Files:**
- Create: `src/components/payment-method-picker.tsx`

**Interfaces:**
- Consumes: `PaymentMethod` type from `@/types/models` (`'cash' | 'zaad' | 'edahab' | 'other'`).
- Produces: `PaymentMethodPicker({ value, onChange })` where `value: PaymentMethod | null` and `onChange: (method: PaymentMethod) => void`. Consumed by Task 6 (`pos.tsx`).

- [ ] **Step 1: Create the component**

```typescript
// src/components/payment-method-picker.tsx
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PaymentMethod } from '@/types/models';

const prominentMethods: { key: PaymentMethod; label: string; icon: string }[] = [
  { key: 'cash', label: 'Cash', icon: '💵' },
  { key: 'zaad', label: 'ZAAD', icon: '📱' },
];

const moreMethods: { key: PaymentMethod; label: string }[] = [
  { key: 'edahab', label: 'e-Dahab' },
  { key: 'other', label: 'Other' },
];

export function PaymentMethodPicker({ value, onChange }: { value: PaymentMethod | null; onChange: (method: PaymentMethod) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View>
      <Text style={styles.heading}>PAYMENT METHOD</Text>
      <View style={styles.row}>
        {prominentMethods.map((method) => (
          <Pressable key={method.key} onPress={() => onChange(method.key)} style={[styles.button, value === method.key && styles.buttonActive]}>
            <Text style={[styles.buttonText, value === method.key && styles.buttonTextActive]}>{method.icon} {method.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => setExpanded((current) => !current)}>
        <Text style={styles.moreToggle}>More options {expanded ? '▴' : '▾'}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.row}>
          {moreMethods.map((method) => (
            <Pressable key={method.key} onPress={() => onChange(method.key)} style={[styles.moreButton, value === method.key && styles.buttonActive]}>
              <Text style={[styles.moreButtonText, value === method.key && styles.buttonTextActive]}>{method.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 11, fontWeight: '700', color: '#999999', letterSpacing: 0.4, marginTop: 18, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  button: { flex: 1, alignItems: 'center', paddingVertical: 14, paddingHorizontal: 8, borderRadius: 10, backgroundColor: '#F2F2F2' },
  buttonActive: { backgroundColor: '#111111' },
  buttonText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  buttonTextActive: { color: '#FFFFFF' },
  moreToggle: { textAlign: 'center', fontSize: 11, color: '#999999', fontWeight: '700', textDecorationLine: 'underline', marginBottom: 8 },
  moreButton: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, borderColor: '#E2E2E2' },
  moreButtonText: { fontSize: 12, fontWeight: '600', color: '#666666' },
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/components/payment-method-picker.tsx
git commit -m "feat: add PaymentMethodPicker with Cash/ZAAD prominent, e-Dahab/Other collapsed"
```

---

### Task 4: Restyle `ProductTile` into a table row + wire up Inventory

**Files:**
- Modify: `src/components/product-tile.tsx` (full rewrite)
- Modify: `src/app/(owner)/(tabs)/inventory.tsx` (full rewrite)

**Interfaces:**
- Produces: `ProductTile({ product, onEdit?, onStockChange? })` — replaces the old `{ product, onPress? }` signature. `onEdit?: () => void` shows a pencil affordance when provided; `onStockChange?: (nextStock: number) => void` shows `−`/`+` steppers when provided. Both stay unset for Task 8's Dashboard low-stock-alerts usage (read-only row, unchanged there).
- Consumes: `Card` (Task 2), `QuantityStepper` (existing, `src/components/quantity-stepper.tsx` — unchanged), `updateProduct` (existing, `src/lib/products.ts:83`).

- [ ] **Step 1: Rewrite `ProductTile`**

```typescript
// src/components/product-tile.tsx
import { Image } from 'expo-image';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCents } from '@/lib/currency';
import type { Product } from '@/types/models';

export function ProductTile({
  product,
  onEdit,
  onStockChange,
}: {
  product: Product;
  onEdit?: () => void;
  onStockChange?: (nextStock: number) => void;
}) {
  const lowStock = product.stock <= (product.reorderLevel ?? 5);
  const outOfStock = product.stock <= 0;

  return (
    <View style={styles.row}>
      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} contentFit="cover" style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]} />
      )}

      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{product.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {product.brand ?? 'No brand'}{product.sku ? ` · ${product.sku}` : ''} · {product.category || 'Uncategorized'}
        </Text>
      </View>

      <Text style={styles.price}>{formatCents(product.priceCents)}</Text>

      <View style={styles.stockSection}>
        {onStockChange ? (
          <View style={styles.stepper}>
            <Pressable onPress={() => onStockChange(Math.max(0, product.stock - 1))} style={styles.stepperButton}><Text style={styles.stepperButtonText}>−</Text></Pressable>
            {outOfStock ? (
              <Text style={styles.outOfStockPill}>Out of stock</Text>
            ) : lowStock ? (
              <Text style={styles.lowStockPill}>⚠ Low stock</Text>
            ) : (
              <Text style={styles.stockCount}>{product.stock}</Text>
            )}
            <Pressable onPress={() => onStockChange(product.stock + 1)} style={styles.stepperButton}><Text style={styles.stepperButtonText}>+</Text></Pressable>
          </View>
        ) : outOfStock ? (
          <Text style={styles.outOfStockPill}>Out of stock</Text>
        ) : lowStock ? (
          <Text style={styles.lowStockPill}>⚠ Low stock</Text>
        ) : (
          <Text style={styles.stockCount}>{product.stock} units</Text>
        )}
      </View>

      {onEdit && (
        <Pressable onPress={onEdit} style={styles.editButton}>
          <Text style={styles.editIcon}>✎</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#F4F4F4', gap: 10 },
  thumb: { width: 34, height: 34, borderRadius: 7 },
  thumbPlaceholder: { backgroundColor: '#F2F2F2' },
  info: { flex: 2 },
  name: { color: '#111111', fontSize: 12, fontWeight: '700' },
  meta: { color: '#999999', fontSize: 10, marginTop: 2 },
  price: { flex: 1, color: '#111111', fontSize: 12, fontWeight: '700' },
  stockSection: { flex: 1.4, alignItems: 'flex-start' },
  stockCount: { color: '#111111', fontSize: 12 },
  lowStockPill: { fontSize: 9, fontWeight: '700', color: '#B5793A', borderWidth: 1, borderColor: '#E8C99B', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  outOfStockPill: { fontSize: 9, fontWeight: '700', color: '#FFFFFF', backgroundColor: '#111111', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 10 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#F2F2F2', alignItems: 'center', justifyContent: 'center' },
  stepperButtonText: { color: '#111111', fontSize: 13, fontWeight: '800' },
  editButton: { width: 24, alignItems: 'center' },
  editIcon: { color: '#BBBBBB', fontSize: 14 },
});
```

- [ ] **Step 2: Rewrite `inventory.tsx`** to use the table header + wire `onEdit`/`onStockChange`

```typescript
// src/app/(owner)/(tabs)/inventory.tsx
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Card } from '@/components/card';
import { ProductTile } from '@/components/product-tile';
import { useAuth } from '@/hooks/use-auth';
import { listProducts, updateProduct } from '@/lib/products';
import type { Product } from '@/types/models';

export default function InventoryScreen() {
  const router = useRouter();
  const { shop } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setProducts(await listProducts(shop.id));
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const adjustStock = async (product: Product, nextStock: number) => {
    const updated = await updateProduct(product.id, { stock: nextStock });
    setProducts((current) => current.map((p) => (p.id === updated.id ? updated : p)));
  };

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()) || p.brand?.toLowerCase().includes(search.toLowerCase()) || p.sku?.toLowerCase().includes(search.toLowerCase()));
  const needsAttention = products.filter((p) => p.stock <= (p.reorderLevel ?? 5)).length;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Inventory</Text>
            <Text style={styles.subtitle}>{products.length} products · {needsAttention} need attention</Text>
          </View>
          <Pressable onPress={() => router.push('/product/new')} style={styles.addButton}>
            <Text style={styles.addButtonText}>+ Add product</Text>
          </Pressable>
        </View>
        <TextInput value={search} onChangeText={setSearch} placeholder="Search by name, brand, or SKU" placeholderTextColor="#999999" style={styles.search} />
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No products yet. Add your first one above.</Text>
        ) : (
          <Card style={styles.list}>
            {filtered.map((product) => (
              <ProductTile
                key={product.id}
                product={product}
                onEdit={() => router.push(`/product/${product.id}`)}
                onStockChange={(next) => adjustStock(product, next)}
              />
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { color: '#111111', fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: '#999999', fontSize: 12, marginTop: 3 },
  addButton: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  addButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 40, paddingHorizontal: 13, marginTop: 18, marginBottom: 18, color: '#111111' },
  list: { overflow: 'hidden' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Task 8's Dashboard still calls `<ProductTile product={product} />` with no `onEdit`/`onStockChange` — both are optional, so that call site keeps compiling untouched until Task 8 restyles its surrounding container.)

- [ ] **Step 4: Manual verification**

Run: `npm run web`, sign in, open Inventory. Confirm: table-style rows with thumbnail/name/brand·SKU·category/price/stock; tapping `−`/`+` updates stock and persists (refresh the page to confirm it stuck); tapping the pencil icon navigates to the product edit screen; low-stock rows show the amber pill, out-of-stock rows show the solid dark pill.

- [ ] **Step 5: Commit**

```bash
git add src/components/product-tile.tsx "src/app/(owner)/(tabs)/inventory.tsx"
git commit -m "feat: restyle ProductTile as table row, wire inline stock editing in Inventory"
```

---

### Task 5: Freeform category & tag entry in `ProductForm`

**Files:**
- Modify: `src/components/product-form.tsx`

**Interfaces:**
- Consumes: `deriveCategories`/`deriveTags` (Task 1), `CategoryChip` (Task 2), `listProducts` (existing, `src/lib/products.ts:52`).
- No change to `ProductForm`'s own props (`{ initial?, onSubmit, submitLabel, shopId }`) — `new.tsx` and `product/[id].tsx` need no changes.

- [ ] **Step 1: Replace the hardcoded category list with shop-derived suggestions + freeform entry, and add tag suggestions**

Replace the top of the file (imports and the hardcoded `categories` constant):

```typescript
// src/components/product-form.tsx (top of file)
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { formatCents, toCents } from '@/lib/currency';
import { listProducts, uploadProductImage } from '@/lib/products';
import { deriveCategories, deriveTags } from '@/lib/product-taxonomy';
import type { NewProductInput, Product } from '@/types/models';
```

(This removes the `const categories = ['Skincare', 'Makeup', 'Hair', 'Body', 'Supplements'];` line entirely — it's fully replaced by the derived list below.)

Inside the `ProductForm` function, replace the `category`/`tags` state declarations and add the suggestion-fetching effect (insert right after the existing `useState` declarations, before `valid`):

```typescript
  const [category, setCategory] = useState(initial?.category ?? '');
  const [addingNewCategory, setAddingNewCategory] = useState(false);
  const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  useEffect(() => {
    listProducts(shopId).then((products) => {
      setCategorySuggestions(deriveCategories(products));
      setTagSuggestions(deriveTags(products));
    });
  }, [shopId]);
```

(Delete the old lines `const [category, setCategory] = useState(initial?.category ?? categories[0]);` and `const [tags, setTags] = useState(initial?.tags?.join(', ') ?? '');` — replaced by the block above.)

Replace the `CATEGORY` field JSX:

```typescript
      <Field label="CATEGORY">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {categorySuggestions.map((item) => (
            <CategoryChip key={item} label={item} active={category === item} onPress={() => { setCategory(item); setAddingNewCategory(false); }} />
          ))}
          <CategoryChip label="+ New" active={addingNewCategory} onPress={() => setAddingNewCategory(true)} />
        </ScrollView>
        {addingNewCategory && (
          <TextInput
            value={category}
            onChangeText={setCategory}
            placeholder="Type a new category"
            placeholderTextColor="#999999"
            autoFocus
            style={styles.input}
          />
        )}
        {!addingNewCategory && category && !categorySuggestions.includes(category) && (
          <Text style={styles.categoryHint}>Selected: {category}</Text>
        )}
      </Field>
```

Replace the `TAGS` field JSX:

```typescript
      <Field label="TAGS">
        <TextInput value={tags} onChangeText={setTags} placeholder="e.g. bestseller, toner" placeholderTextColor="#999999" style={styles.input} />
        {tagSuggestions.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {tagSuggestions.map((tag) => (
              <CategoryChip
                key={tag}
                label={tag}
                active={tags.split(',').map((t) => t.trim()).includes(tag)}
                onPress={() => {
                  const current = tags.split(',').map((t) => t.trim()).filter(Boolean);
                  if (current.includes(tag)) return;
                  setTags([...current, tag].join(', '));
                }}
              />
            ))}
          </ScrollView>
        )}
      </Field>
```

Add one style to the `styles` object (insert alongside the existing `chips`/`chip*` entries):

```typescript
  categoryHint: { color: '#999999', fontSize: 11, marginTop: 6 },
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manual verification**

Run: `npm run web`. Open Inventory → "+ Add product" for a shop that already has products: confirm category chips show that shop's real existing categories (not "Skincare/Makeup/Hair/Body/Supplements"), tapping "+ New" reveals a text input for a fresh category, and tag suggestion chips appear below the tags field and append to it on tap without duplicating. For a shop with zero products, confirm no chips render and both fields fall back to plain text entry.

- [ ] **Step 4: Commit**

```bash
git add src/components/product-form.tsx
git commit -m "feat: replace hardcoded category list with freeform, shop-derived category/tag suggestions"
```

---

### Task 6: Rename `/sell` → `/pos`, restyle the POS screen

**Files:**
- Create: `src/app/(owner)/(tabs)/pos.tsx` (moved + restyled from `sell.tsx`)
- Delete: `src/app/(owner)/(tabs)/sell.tsx`
- Modify: `src/components/owner-tabs.web.tsx:17` (trigger name/href/label — minimal edit only, full sidebar rebuild is Task 7)
- Modify: `src/components/owner-tabs.tsx:19-22` (trigger name/label)

**Interfaces:**
- Consumes: `Card`, `CategoryChip` (Task 2), `PaymentMethodPicker` (Task 3), `deriveCategories` (Task 1), existing `QuantityStepper`, `cartTotalCents`, `formatCents`, `listProducts`, `completeSale`.
- `paymentMethod` local state changes type from `PaymentMethod` (defaulted to `'cash'`) to `PaymentMethod | null` (defaults to `null`) — per the design spec, neither Cash nor ZAAD is pre-selected, so a forgotten tap can't silently submit as the wrong method.

- [ ] **Step 1: Rename the route file with `git mv`**

```bash
git mv "src/app/(owner)/(tabs)/sell.tsx" "src/app/(owner)/(tabs)/pos.tsx"
```

- [ ] **Step 2: Rewrite `pos.tsx`**

```typescript
// src/app/(owner)/(tabs)/pos.tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/category-chip';
import { PaymentMethodPicker } from '@/components/payment-method-picker';
import { QuantityStepper } from '@/components/quantity-stepper';
import { useAuth } from '@/hooks/use-auth';
import { cartTotalCents } from '@/lib/cart';
import { formatCents } from '@/lib/currency';
import { deriveCategories } from '@/lib/product-taxonomy';
import { listProducts } from '@/lib/products';
import { completeSale } from '@/lib/sales';
import type { CartLine, PaymentMethod, Product } from '@/types/models';

// Real `Error` instances have `.message`, but Supabase's `rpc()`/query errors
// (e.g. PostgrestError from the complete_sale RPC — "insufficient stock for
// X: has 7, need 100") are plain `{code, details, hint, message}` objects
// that are never `instanceof Error`. Check for a string `.message` on either
// shape so the owner sees the RPC's actual reason instead of a generic one.
function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Could not complete this sale.';
}

export default function PosScreen() {
  const { shop } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!shop) return;
    setProducts(await listProducts(shop.id));
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const categories = useMemo(() => deriveCategories(products), [products]);

  const filtered = products.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) &&
    (category === null || p.category === category)
  );

  const addToCart = (product: Product) => {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) return current.map((line) => (line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line));
      return [...current, { product, quantity: 1 }];
    });
  };

  const setQuantity = (productId: string, quantity: number) => {
    setCart((current) => (quantity === 0 ? current.filter((line) => line.product.id !== productId) : current.map((line) => (line.product.id === productId ? { ...line, quantity } : line))));
  };

  const total = cartTotalCents(cart);

  const checkout = async () => {
    if (!shop || cart.length === 0 || !paymentMethod) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeSale(shop.id, cart, paymentMethod);
      setCart([]);
      await reload();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.split}>
        <View style={styles.browsePane}>
          <TextInput value={search} onChangeText={setSearch} placeholder="Search products or brands" placeholderTextColor="#999999" style={styles.search} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
            <CategoryChip label="All" active={category === null} onPress={() => setCategory(null)} />
            {categories.map((item) => (
              <CategoryChip key={item} label={item} active={category === item} onPress={() => setCategory(item)} />
            ))}
          </ScrollView>
          <ScrollView contentContainerStyle={styles.grid}>
            {filtered.map((product) => (
              <Pressable key={product.id} onPress={() => addToCart(product)} disabled={product.stock <= 0} style={[styles.gridTile, product.stock <= 0 && styles.gridTileDisabled]}>
                {product.brand && <Text style={styles.gridBrand}>{product.brand.toUpperCase()}</Text>}
                <Text style={styles.gridName} numberOfLines={2}>{product.name}</Text>
                <View style={styles.gridFooter}>
                  <Text style={styles.gridPrice}>{formatCents(product.priceCents)}</Text>
                  {product.stock <= 0 ? (
                    <Text style={styles.outOfStockPill}>Out of stock</Text>
                  ) : product.stock <= (product.reorderLevel ?? 5) ? (
                    <Text style={styles.lowStockPill}>⚠ Low stock</Text>
                  ) : (
                    <Text style={styles.gridStock}>{product.stock} in stock</Text>
                  )}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <View style={styles.cartPane}>
          <Text style={styles.cartTitle}>Current sale</Text>
          <ScrollView style={styles.cartList}>
            {cart.length === 0 ? (
              <Text style={styles.empty}>Cart is empty.{'\n'}Tap a product to add it.</Text>
            ) : (
              cart.map((line) => (
                <View key={line.product.id} style={styles.cartLine}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cartLineName}>{line.product.name}</Text>
                    <Text style={styles.cartLinePrice}>{formatCents(line.product.priceCents)}</Text>
                  </View>
                  <QuantityStepper quantity={line.quantity} onChange={(next) => setQuantity(line.product.id, next)} />
                </View>
              ))
            )}
          </ScrollView>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatCents(total)}</Text>
          </View>
          <PaymentMethodPicker value={paymentMethod} onChange={setPaymentMethod} />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable onPress={checkout} disabled={cart.length === 0 || !paymentMethod || submitting} style={[styles.checkout, (cart.length === 0 || !paymentMethod || submitting) && styles.checkoutDisabled]}>
            <Text style={styles.checkoutText}>{submitting ? 'Completing…' : 'Complete sale'}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  split: { flex: 1, flexDirection: 'row' },
  browsePane: { flex: 2, padding: 18 },
  search: { backgroundColor: '#F2F2F2', borderRadius: 10, height: 42, paddingHorizontal: 14, marginBottom: 14, color: '#111111' },
  categoryRow: { gap: 8, paddingBottom: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridTile: { width: 160, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#EDEDED' },
  gridTileDisabled: { opacity: 0.4 },
  gridBrand: { color: '#999999', fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  gridName: { color: '#111111', fontSize: 12, fontWeight: '700', minHeight: 32, marginTop: 2 },
  gridFooter: { marginTop: 10, gap: 4 },
  gridPrice: { color: '#111111', fontSize: 14, fontWeight: '800' },
  gridStock: { color: '#999999', fontSize: 10 },
  lowStockPill: { fontSize: 9, fontWeight: '700', color: '#B5793A', borderWidth: 1, borderColor: '#E8C99B', paddingVertical: 3, paddingHorizontal: 7, borderRadius: 9, alignSelf: 'flex-start' },
  outOfStockPill: { fontSize: 9, fontWeight: '700', color: '#FFFFFF', backgroundColor: '#111111', paddingVertical: 3, paddingHorizontal: 7, borderRadius: 9, alignSelf: 'flex-start' },
  cartPane: { flex: 1, backgroundColor: '#FFFFFF', borderLeftWidth: 1, borderLeftColor: '#ECECEC', padding: 18, minWidth: 280 },
  cartTitle: { color: '#111111', fontSize: 18, fontWeight: '800', marginBottom: 12 },
  cartList: { flex: 1 },
  empty: { color: '#BBBBBB', fontSize: 12, marginTop: 40, textAlign: 'center' },
  cartLine: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 10, padding: 10, marginBottom: 7 },
  cartLineName: { color: '#111111', fontSize: 12, fontWeight: '700' },
  cartLinePrice: { color: '#999999', fontSize: 11, marginTop: 2 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 12, borderTopWidth: 1, borderTopColor: '#ECECEC', marginTop: 8 },
  totalLabel: { color: '#111111', fontSize: 14, fontWeight: '800' },
  totalValue: { color: '#111111', fontSize: 22, fontWeight: '800' },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 8 },
  checkout: { backgroundColor: '#111111', height: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  checkoutDisabled: { backgroundColor: '#CCCCCC' },
  checkoutText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
});
```

- [ ] **Step 3: Update the web tab trigger** (`src/components/owner-tabs.web.tsx:17`)

```typescript
          <TabTrigger name="pos" href="/pos" asChild><NavButton compact={compact} position={1}>POS</NavButton></TabTrigger>
```

(Replaces the old `<TabTrigger name="sell" href="/sell" asChild>...>Sell</NavButton></TabTrigger>` line only — the rest of `owner-tabs.web.tsx` (the top-bar layout, `compact` responsive logic, `Header`/`NavButton` styling) stays exactly as it is today. Task 7 replaces the whole file with the sidebar layout; this task's edit only needs the route/label current so `/pos` works before then.)

- [ ] **Step 4: Update the native tab trigger** (`src/components/owner-tabs.tsx:19-22`)

```typescript
      <NativeTabs.Trigger name="pos">
        <NativeTabs.Trigger.Label>POS</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/explore.png')} />
      </NativeTabs.Trigger>
```

(Replaces the old `name="sell"` / `Sell` trigger block. Icon stays the same — native icon selection is out of scope.)

- [ ] **Step 5: Confirm no other references to `/sell` remain**

Run: `grep -rn "'/sell'\|\"/sell\"\|name=\"sell\"" --include="*.ts" --include="*.tsx" src/`
Expected: no output (both matches from before this task are now updated)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Manual verification**

Run: `npm run web`, sign in, confirm the URL `/pos` loads the renamed screen: search box, category chips (derived from the shop's real products — "All" plus each distinct category), product grid, cart pane with Cash/ZAAD buttons and collapsed "More options", and that "Complete sale" stays disabled until both a cart item and a payment method are selected.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(owner)/(tabs)/pos.tsx" "src/app/(owner)/(tabs)/sell.tsx" src/components/owner-tabs.web.tsx src/components/owner-tabs.tsx
git commit -m "feat: rename Sell to POS, restyle with category filters and prioritized payment methods"
```

---

### Task 7: Rebuild `owner-tabs.web.tsx` as a left sidebar

**Files:**
- Modify: `src/components/owner-tabs.web.tsx` (full rewrite)

**Interfaces:**
- Consumes: `useAuth()` (existing, `src/hooks/use-auth.tsx` — `shop: Shop | null`), `signOut()` (existing, `src/lib/auth`).
- Nav order: Dashboard, POS, Inventory, Sales (routes `/dashboard`, `/pos`, `/inventory`, `/sales` — `/pos` exists as of Task 6).

- [ ] **Step 1: Rewrite the file**

```typescript
// src/components/owner-tabs.web.tsx
import { Tabs, TabList, TabListProps, TabSlot, TabTrigger, TabTriggerSlotProps } from 'expo-router/ui';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { signOut } from '@/lib/auth';

export default function OwnerTabs() {
  return (
    <Tabs style={styles.tabs}>
      <TabList asChild>
        <Sidebar>
          <TabTrigger name="dashboard" href="/dashboard" asChild><NavButton>Dashboard</NavButton></TabTrigger>
          <TabTrigger name="pos" href="/pos" asChild><NavButton>POS</NavButton></TabTrigger>
          <TabTrigger name="inventory" href="/inventory" asChild><NavButton>Inventory</NavButton></TabTrigger>
          <TabTrigger name="sales" href="/sales" asChild><NavButton>Sales</NavButton></TabTrigger>
        </Sidebar>
      </TabList>
      <TabSlot style={styles.slot} />
    </Tabs>
  );
}

function Sidebar({ children, style, ...props }: TabListProps) {
  const router = useRouter();
  const { shop } = useAuth();
  const initial = (shop?.name ?? 'K').charAt(0).toUpperCase();
  const subtitle = shop?.categories?.[0];

  return (
    <View {...props} style={[styles.sidebar, style]}>
      <View style={styles.header}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initial}</Text></View>
        <View>
          <Text style={styles.shopName} numberOfLines={1}>{shop?.name ?? 'Your shop'}</Text>
          {subtitle && <Text style={styles.shopSubtitle}>{subtitle}</Text>}
        </View>
      </View>
      <View style={styles.nav}>{children}</View>
      <View style={styles.footer}>
        <Text style={styles.poweredBy}>Powered by Ka Iibi</Text>
        <Pressable onPress={() => signOut().then(() => router.replace('/signup'))}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

function NavButton({ children, isFocused, style: _style, ...props }: TabTriggerSlotProps) {
  return (
    <Pressable {...props} style={({ pressed }) => [styles.navButton, isFocused && styles.navButtonFocused, pressed && styles.pressed]}>
      <Text style={[styles.navText, isFocused && styles.navTextFocused]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flex: 1, flexDirection: 'row' },
  sidebar: { width: 220, flexShrink: 0, backgroundColor: '#FFFFFF', borderRightWidth: 1, borderRightColor: '#ECECEC', paddingVertical: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 24 },
  avatar: { width: 34, height: 34, borderRadius: 9, backgroundColor: '#17261F', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  shopName: { color: '#111111', fontSize: 15, fontWeight: '800', maxWidth: 140 },
  shopSubtitle: { color: '#999999', fontSize: 11, marginTop: 1 },
  nav: { paddingHorizontal: 10, gap: 2 },
  navButton: { paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  navButtonFocused: { backgroundColor: '#F2F2F2' },
  pressed: { opacity: 0.75 },
  navText: { color: '#555555', fontSize: 13, fontWeight: '600' },
  navTextFocused: { color: '#111111', fontWeight: '800' },
  footer: { marginTop: 'auto', paddingHorizontal: 20, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#ECECEC', gap: 4 },
  poweredBy: { color: '#BBBBBB', fontSize: 10, fontWeight: '700' },
  signOut: { color: '#999999', fontSize: 11, fontWeight: '700' },
  slot: { flex: 1 },
});
```

Note: this drops the old `compact`/`useWindowDimensions` responsive top-bar behavior — a fixed-width sidebar doesn't need it (it doesn't reflow at narrow widths in the reference design either). If the app must still support narrow/mobile web viewports gracefully, that's a follow-up, not part of this pass — flag it in manual verification rather than silently patching in new responsive logic that wasn't in the design.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Manual verification**

Run: `npm run web`, sign in. Confirm: left sidebar shows the signed-in shop's real name (and category, if it has one) at top, not "Ka Iibi · Owner"; nav order is Dashboard/POS/Inventory/Sales; the active route's nav item has the light-gray pill background; "Powered by Ka Iibi" + "Sign out" sit at the bottom; sign-out still navigates to `/signup`.

- [ ] **Step 4: Commit**

```bash
git add src/components/owner-tabs.web.tsx
git commit -m "feat: rebuild owner web nav as a left sidebar with shop identity"
```

---

### Task 8: Restyle Dashboard

**Files:**
- Modify: `src/app/(owner)/(tabs)/dashboard.tsx` (full rewrite)
- Modify: `src/components/revenue-chart.tsx:20` (bar color)

**Interfaces:**
- Consumes: `StatTile` (Task 2), `Card` (Task 2), existing `ProductTile` (Task 4's new signature — called here with neither `onEdit` nor `onStockChange`, so it renders as the read-only row).

- [ ] **Step 1: Rewrite `dashboard.tsx`**

Removes the redundant inline sign-out button (the sidebar's footer now owns sign-out — see Task 7) and switches `MetricTile` → `StatTile`, wraps list sections in `Card`.

```typescript
// src/app/(owner)/(tabs)/dashboard.tsx
import { useCallback, useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { ProductTile } from '@/components/product-tile';
import { RevenueChart } from '@/components/revenue-chart';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { getLowStockProducts } from '@/lib/products';
import { getDailyTotalsCents, getTopSellingProducts, listSales } from '@/lib/sales';
import type { Product, Sale } from '@/types/models';

export default function DashboardScreen() {
  const { shop } = useAuth();
  const [recentSales, setRecentSales] = useState<Sale[]>([]);
  const [topProducts, setTopProducts] = useState<{ name: string; quantitySold: number; revenueCents: number }[]>([]);
  const [lowStock, setLowStock] = useState<Product[]>([]);
  const [dailyTotals, setDailyTotals] = useState<{ day: string; totalCents: number; orderCount: number }[]>([]);

  const reload = useCallback(async () => {
    if (!shop) return;
    const [sales, top, low, daily] = await Promise.all([
      listSales(shop.id, 5),
      getTopSellingProducts(shop.id),
      getLowStockProducts(shop.id),
      getDailyTotalsCents(shop.id),
    ]);
    setRecentSales(sales);
    setTopProducts(top);
    setLowStock(low);
    setDailyTotals(daily);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const todayTotalCents = dailyTotals.at(-1)?.totalCents ?? 0;
  const todayOrders = dailyTotals.at(-1)?.orderCount ?? 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.greeting}>{shop?.name ?? 'Your shop'}</Text>

        <View style={styles.metricRow}>
          <StatTile value={formatCents(todayTotalCents)} label="Today's sales" />
          <StatTile value={String(todayOrders)} label="Orders" />
          <StatTile value={String(lowStock.length)} label="Low stock" />
        </View>

        <Text style={styles.sectionTitle}>Last 7 days</Text>
        <Card style={styles.chartCard}><RevenueChart data={dailyTotals} /></Card>

        <Text style={styles.sectionTitle}>Top selling products</Text>
        {topProducts.length === 0 ? (
          <Text style={styles.empty}>No sales yet this week.</Text>
        ) : (
          <Card style={styles.list}>
            {topProducts.map((product) => (
              <View key={product.name} style={styles.topRow}>
                <Text style={styles.topName} numberOfLines={1}>{product.name}</Text>
                <Text style={styles.topMeta}>{product.quantitySold} sold · {formatCents(product.revenueCents)}</Text>
              </View>
            ))}
          </Card>
        )}

        <Text style={styles.sectionTitle}>Inventory alerts</Text>
        {lowStock.length === 0 ? (
          <Text style={styles.empty}>Everything is well stocked.</Text>
        ) : (
          <Card style={styles.list}>
            {lowStock.map((product) => <ProductTile key={product.id} product={product} />)}
          </Card>
        )}

        <Text style={styles.sectionTitle}>Recent transactions</Text>
        {recentSales.length === 0 ? (
          <Text style={styles.empty}>No transactions yet.</Text>
        ) : (
          <Card style={styles.list}>
            {recentSales.map((sale) => (
              <View key={sale.id} style={styles.topRow}>
                <Text style={styles.topName} numberOfLines={1}>{sale.items?.map((item) => item.productName).join(', ')}</Text>
                <Text style={styles.topMeta}>{formatCents(sale.totalCents)}</Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  greeting: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 20 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 28 },
  sectionTitle: { color: '#111111', fontSize: 15, fontWeight: '800', marginTop: 10, marginBottom: 12 },
  chartCard: { padding: 16, marginBottom: 8 },
  list: { overflow: 'hidden', marginBottom: 8 },
  topRow: { padding: 13, borderBottomWidth: 1, borderBottomColor: '#F4F4F4' },
  topName: { color: '#111111', fontSize: 13, fontWeight: '700' },
  topMeta: { color: '#999999', fontSize: 11, marginTop: 3 },
  empty: { color: '#999999', fontSize: 13, marginBottom: 8 },
});
```

- [ ] **Step 2: Update the chart bar color** (`src/components/revenue-chart.tsx:20`)

```typescript
  bar: { width: '100%', backgroundColor: '#111111', borderRadius: 4 },
```

(Replaces `backgroundColor: '#E45B37'` — the last remaining terracotta reference in the redesigned screens.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Manual verification**

Run: `npm run web`, sign in, land on Dashboard (still the default post-login route). Confirm: no duplicate sign-out button at the top (sidebar owns it now), stat tiles are white/monochrome (no pastel backgrounds), chart bars are black, all list sections sit inside white bordered cards.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(owner)/(tabs)/dashboard.tsx" src/components/revenue-chart.tsx
git commit -m "feat: restyle Dashboard onto Card/StatTile, remove redundant sign-out button"
```

---

### Task 9: Restyle Sales, delete `metric-tile.tsx`

**Files:**
- Modify: `src/app/(owner)/(tabs)/sales.tsx` (full rewrite)
- Delete: `src/components/metric-tile.tsx` (Task 8's Dashboard was the other consumer and no longer imports it — this is now the last one)

**Interfaces:**
- Consumes: `StatTile`, `Card` (Task 2).

- [ ] **Step 1: Confirm `metric-tile.tsx` has no remaining consumers**

Run: `grep -rn "metric-tile\|MetricTile" --include="*.ts" --include="*.tsx" src/`
Expected: only `src/components/metric-tile.tsx` itself (Task 8 already removed Dashboard's import; this task removes the only other one)

- [ ] **Step 2: Rewrite `sales.tsx`**

```typescript
// src/app/(owner)/(tabs)/sales.tsx
import { useCallback, useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card } from '@/components/card';
import { StatTile } from '@/components/stat-tile';
import { useAuth } from '@/hooks/use-auth';
import { formatCents } from '@/lib/currency';
import { listSales } from '@/lib/sales';
import type { Sale } from '@/types/models';

const paymentLabels: Record<Sale['paymentMethod'], string> = { cash: 'Cash', zaad: 'ZAAD', edahab: 'e-Dahab', other: 'Other' };

export default function SalesScreen() {
  const { shop } = useAuth();
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!shop) return;
    setLoading(true);
    setSales(await listSales(shop.id));
    setLoading(false);
  }, [shop]);

  useEffect(() => { reload(); }, [reload]);

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todaySales = sales.filter((sale) => new Date(sale.createdAt) >= todayStart);
  const todayTotalCents = todaySales.reduce((sum, sale) => sum + sale.totalCents, 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Sales</Text>
        <View style={styles.metricRow}>
          <StatTile value={formatCents(todayTotalCents)} label="Sales today" />
          <StatTile value={String(todaySales.length)} label="Orders today" />
        </View>
        {loading ? (
          <Text style={styles.empty}>Loading…</Text>
        ) : sales.length === 0 ? (
          <Text style={styles.empty}>No sales yet.</Text>
        ) : (
          <Card style={styles.list}>
            {sales.map((sale) => (
              <View key={sale.id} style={styles.saleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.saleItems} numberOfLines={1}>{sale.items?.map((item) => `${item.quantity}× ${item.productName}`).join(', ')}</Text>
                  <Text style={styles.saleMeta}>{new Date(sale.createdAt).toLocaleString()} · {paymentLabels[sale.paymentMethod]}</Text>
                </View>
                <Text style={styles.saleTotal}>{formatCents(sale.totalCents)}</Text>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 24, paddingBottom: 42 },
  title: { color: '#111111', fontSize: 26, fontWeight: '800', letterSpacing: -1, marginBottom: 20 },
  metricRow: { flexDirection: 'row', gap: 10, marginBottom: 26 },
  list: { overflow: 'hidden' },
  saleRow: { flexDirection: 'row', alignItems: 'center', padding: 13, borderBottomWidth: 1, borderBottomColor: '#F4F4F4' },
  saleItems: { color: '#111111', fontSize: 13, fontWeight: '700' },
  saleMeta: { color: '#999999', fontSize: 11, marginTop: 3 },
  saleTotal: { color: '#111111', fontSize: 14, fontWeight: '800' },
  empty: { color: '#999999', fontSize: 13, marginTop: 20, textAlign: 'center' },
});
```

- [ ] **Step 3: Delete `metric-tile.tsx`**

```bash
git rm src/components/metric-tile.tsx
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus Task 1's new `product-taxonomy.test.ts`

- [ ] **Step 6: Manual verification — full pass across all four screens**

Run: `npm run web`, sign in. Walk through Dashboard → POS → Inventory → Sales via the sidebar. Confirm every screen shares the same white background, `#111111`/`#999999` text, `#EDEDED`-bordered cards, and that no terracotta (`#E45B37`) or pastel `tone` colors remain anywhere in the four screens.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(owner)/(tabs)/sales.tsx" src/components/metric-tile.tsx
git commit -m "feat: restyle Sales onto Card/StatTile, remove now-unused MetricTile"
```
