import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { hasMultipleLocations } from '@/lib/location-selection';
import { AppModal } from '@/components/ui/app-modal';

// Which branch this device is operating at. Rendered in all three admin shells
// (sidebar, native tabs, mobile web tabs), which is why it reads the auth
// context itself rather than taking props -- the alternative was the same
// wiring copied three times.
//
// Renders NOTHING for a shop with one location, which is the norm. A single-
// store shop must not pay for this feature with a control it can never use, so
// the whole thing stays invisible until a second branch exists.
export function LocationSwitcher({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  const { locations, activeLocation, setActiveLocation } = useAuth();
  const [open, setOpen] = useState(false);

  if (!hasMultipleLocations(locations)) return null;

  const selectable = locations.filter((location) => location.active);
  const dark = tone === 'dark';

  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={6} style={[styles.trigger, dark && styles.triggerDark]}>
        <Text style={[styles.triggerText, dark && styles.triggerTextDark]} numberOfLines={1}>
          {activeLocation?.name ?? 'Choose location'}
        </Text>
        <Text style={[styles.chevron, dark && styles.triggerTextDark]}>▾</Text>
      </Pressable>

      <AppModal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Location</Text>
            <Text style={styles.sheetHint}>Sales, stock and shifts on this device belong to the branch you pick here.</Text>
            {selectable.map((location) => {
              const selected = location.id === activeLocation?.id;
              // Computed once and coerced to a real conditional. `describe()`
              // returns a STRING, so `describe(...) && <Text/>` renders the
              // empty string itself when there is nothing to show — and a bare
              // text node inside a <View> is a hard error on React Native Web.
              const meta = describe(location.address, location.neighborhood, location.city);
              return (
                <Pressable
                  key={location.id}
                  onPress={() => {
                    setActiveLocation(location.id);
                    setOpen(false);
                  }}
                  style={[styles.option, selected && styles.optionSelected]}
                >
                  <View style={styles.optionText}>
                    <Text style={styles.optionName}>{location.name}</Text>
                    {meta ? (
                      <Text style={styles.optionMeta} numberOfLines={1}>{meta}</Text>
                    ) : null}
                  </View>
                  {selected && <Text style={styles.check}>✓</Text>}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </AppModal>
    </>
  );
}

function describe(...parts: (string | null)[]): string {
  return parts.filter(Boolean).join(' · ');
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F2F2F2', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, maxWidth: 180 },
  triggerDark: { backgroundColor: 'rgba(255,255,255,0.12)' },
  triggerText: { fontSize: 12, fontWeight: '800', color: '#111111', flexShrink: 1 },
  triggerTextDark: { color: '#FFFFFF' },
  chevron: { fontSize: 10, color: '#111111' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 420 },
  sheetTitle: { fontSize: 16, fontWeight: '800', color: '#111111' },
  sheetHint: { fontSize: 12, color: '#9CA3AF', lineHeight: 17, marginTop: 4, marginBottom: 12 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10 },
  optionSelected: { backgroundColor: '#F2F2F2' },
  optionText: { flex: 1 },
  optionName: { fontSize: 14, fontWeight: '700', color: '#111111' },
  optionMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  check: { fontSize: 14, fontWeight: '800', color: '#111111' },
});
