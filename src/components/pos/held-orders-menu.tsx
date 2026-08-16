import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
import { formatCents } from '@/lib/currency';
import type { HeldOrder } from '@/lib/held-orders';

// Pinned to the light palette for now -- no dark-mode switching yet.
const theme = Colors.light;

// The clock time it was parked, not "12m ago". Relative time needs `Date.now()`
// during render -- which is impure, and goes stale on a screen that sits open
// at a counter all afternoon. "held 8:42 PM" is true whenever it is read, and
// it is what a cashier and a customer can actually compare notes on.
function heldAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The parked sales, behind the stack beside the title.
 *
 * Renders nothing at all when nothing is parked: a control for a queue that is
 * empty is a control a cashier has to learn to ignore. The badge is the count,
 * so a shift cannot end with a basket forgotten behind a silent icon.
 */
export function HeldOrdersMenu({
  orders,
  onResume,
}: {
  orders: HeldOrder[];
  onResume: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (orders.length === 0) return null;

  return (
    <View>
      <Pressable onPress={() => setOpen((wasOpen) => !wasOpen)} style={[styles.button, open && styles.buttonOpen]}>
        <Text style={[styles.buttonText, open && styles.buttonTextOpen]}>Held</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{orders.length}</Text>
        </View>
      </Pressable>

      {open && (
        <View style={styles.list}>
          {orders.map((order) => (
            <View key={order.id} style={styles.row}>
              <View style={styles.meta}>
                <Text style={styles.name}>{order.customer?.name ?? 'Walk-in customer'}</Text>
                <Text style={styles.sub}>
                  {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'} · held {heldAt(order.heldAt)}
                </Text>
              </View>
              <Text style={styles.total}>{formatCents(order.totalCents)}</Text>
              <Pressable onPress={() => { setOpen(false); onResume(order.id); }} style={styles.resume}>
                <Text style={styles.resumeText}>Resume</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 11 },
  buttonOpen: { backgroundColor: theme.bentoInk },
  buttonText: { color: theme.bentoMuted, fontSize: 11.5, fontWeight: '700' },
  buttonTextOpen: { color: theme.bentoSurface },
  badge: { minWidth: 18, height: 18, borderRadius: 999, paddingHorizontal: 5, backgroundColor: theme.bentoAccentInk, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: theme.bentoSurface, fontSize: 10, fontWeight: '800' },
  // Absolute so opening the queue does not shove the sale down the screen --
  // it is a menu over the panel, not a section of it.
  list: { position: 'absolute', top: 32, right: 0, minWidth: 260, backgroundColor: theme.bentoSurface, borderRadius: BENTO_RADIUS_TILE, paddingVertical: 4, zIndex: 20, elevation: 6, shadowColor: '#0b0b0d', shadowOpacity: 0.14, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12 },
  meta: { flex: 1, minWidth: 0 },
  name: { color: theme.bentoInk, fontSize: 12.5, fontWeight: '700' },
  sub: { color: theme.bentoMuted, fontSize: 11 },
  total: { color: theme.bentoInk, fontSize: 12.5, fontWeight: '800' },
  resume: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12 },
  resumeText: { color: theme.bentoInk2, fontSize: 11.5, fontWeight: '700' },
});
