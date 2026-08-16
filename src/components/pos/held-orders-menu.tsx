import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppModal } from '@/components/ui/app-modal';
import { BENTO_RADIUS, BENTO_RADIUS_TILE, Colors } from '@/constants/theme';
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
 * A modal rather than a dropdown: the sale panel is a card with `overflow:
 * hidden` (it has to be, or the grey total block would square off its rounded
 * corners), so anything absolutely positioned inside it is clipped and paints
 * under the customer row. A list of baskets is also worth the full screen when
 * a queue is four deep.
 *
 * Renders nothing at all when nothing is parked: a control for an empty queue
 * is one a cashier has to learn to ignore. The badge is the count, so a shift
 * cannot end with a basket forgotten behind a silent icon.
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
      <Pressable onPress={() => setOpen(true)} style={styles.button} accessibilityLabel="Held sales">
        <Text style={styles.buttonText}>Held</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{orders.length}</Text>
        </View>
      </Pressable>

      <AppModal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.header}>
              <Text style={styles.title}>Held sales</Text>
              <Pressable onPress={() => setOpen(false)} style={styles.close}>
                <Text style={styles.closeText}>Close</Text>
              </Pressable>
            </View>

            <Text style={styles.note}>
              Resuming one parks whatever is on the till first, so nothing is lost either way.
            </Text>

            <ScrollView style={styles.list}>
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
            </ScrollView>
          </Pressable>
        </Pressable>
      </AppModal>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.bentoInk, borderRadius: 999, paddingVertical: 10, paddingHorizontal: 13 },
  buttonText: { color: theme.bentoSurface, fontSize: 13.5, fontWeight: '800' },
  badge: { minWidth: 18, height: 18, borderRadius: 999, paddingHorizontal: 5, backgroundColor: theme.bentoAccentInk, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: theme.bentoSurface, fontSize: 10, fontWeight: '800' },
  overlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '80%', backgroundColor: theme.bentoSurface, borderRadius: BENTO_RADIUS, padding: 18 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { color: theme.bentoInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  close: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingVertical: 7, paddingHorizontal: 14 },
  closeText: { color: theme.bentoInk2, fontSize: 12.5, fontWeight: '700' },
  note: { color: theme.bentoMuted, fontSize: 11.5, marginBottom: 10 },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: theme.bentoSoft, borderRadius: BENTO_RADIUS_TILE, paddingVertical: 11, paddingHorizontal: 12, marginBottom: 8 },
  meta: { flex: 1, minWidth: 0 },
  name: { color: theme.bentoInk, fontSize: 13, fontWeight: '700' },
  sub: { color: theme.bentoMuted, fontSize: 11 },
  total: { color: theme.bentoInk, fontSize: 13, fontWeight: '800' },
  resume: { backgroundColor: theme.bentoInk, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14 },
  resumeText: { color: theme.bentoSurface, fontSize: 12, fontWeight: '800' },
});
