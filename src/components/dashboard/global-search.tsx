import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { searchEverything, type SearchResult, type SearchResultKind } from '@/lib/search';

const theme = Colors.light;

const KIND_ICON: Record<SearchResultKind, string> = {
  product: '▦',
  customer: '👤',
  staff: '👥',
  sale: '🧾',
  invoice: '📄',
  expense: '💸',
};

const KIND_LABEL: Record<SearchResultKind, string> = {
  product: 'Product',
  customer: 'Customer',
  staff: 'Team',
  sale: 'Sale',
  invoice: 'Bill',
  expense: 'Expense',
};

const DEBOUNCE_MS = 250;

// Keeps focus in the search field when the pointer goes down on the results
// panel, on web only.
//
// Without it the panel cannot be clicked at all. The browser moves focus as the
// DEFAULT ACTION of mousedown, so `onBlur` below runs in that same task and
// unmounts the rows -- while react-native-web has only just STARTED the press:
// its Pressable defaults `delayPressIn` to 50ms, so `onPressIn` is a timer, not
// a synchronous callback. Unmounting the row cancels that timer
// (usePressEvents' cleanup calls PressResponder.reset()), so neither onPressIn
// nor onPress ever fires and a click selects nothing.
//
// Suppressing the default action removes the race rather than trying to win it:
// the field never blurs, the rows stay mounted, and a plain `onPress` fires on
// release the way it does anywhere else. Native has no mousedown and does not
// blur on tap -- `keyboardShouldPersistTaps` covers it there -- so this is
// scoped to web.
const keepFieldFocused =
  Platform.OS === 'web' ? { onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() } : null;

// The header's search field, and the results list under it.
//
// Debounced and self-cancelling: every keystroke would otherwise fan out to
// six tables, and a slow early query could land after a fast later one and
// overwrite newer results with older ones. The request id below is what stops
// that -- a response whose id is no longer current is dropped rather than
// rendered.
export function GlobalSearch({ onSelect }: { onSelect: (result: SearchResult) => void }) {
  const { shop, can } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // Monotonic; only the newest request may write to state.
  const requestId = useRef(0);

  useEffect(() => {
    const term = query.trim();
    // Bumped on EVERY change, including one that shortens the term below the
    // floor: it invalidates whatever is in flight, so a response for "sugar"
    // can't land after the reader has backed the field down to "su".
    const id = ++requestId.current;
    if (!shop || term.length < 2) return;

    // All state writes happen inside the timer rather than in the effect
    // body. Setting state synchronously in an effect cascades a render on
    // every keystroke -- and there is nothing to show yet at that point
    // anyway, since the request has not been made.
    const timer = setTimeout(() => {
      setLoading(true);
      searchEverything(shop.id, term, { can })
        .then((rows) => {
          if (requestId.current !== id) return;
          setResults(rows);
        })
        .catch(() => {
          if (requestId.current !== id) return;
          // Every branch inside searchEverything already settles
          // independently, so reaching here means something broader failed.
          // An empty list plus the "no matches" line is a better answer than
          // an error banner over a search box.
          setResults([]);
        })
        .finally(() => {
          if (requestId.current !== id) return;
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, shop, can]);

  // Stale results from the previous term stay on screen while a new one is in
  // flight, rather than blanking to empty on every keystroke. `loading` says
  // that a newer answer is coming.
  const showPanel = open && query.trim().length >= 2;

  return (
    <View style={styles.wrap}>
      <View style={styles.field}>
        <Text style={styles.icon}>🔍</Text>
        <TextInput
          value={query}
          // Typing reopens the panel as well as focusing does. Selecting a
          // result closes it without giving the field's focus away, so a reader
          // who comes back and types again would otherwise sit in front of a
          // field that searches but shows nothing.
          onChangeText={(text) => {
            setQuery(text);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Closing on blur is what gives the panel a way OUT. Without it the
          // only exits were picking a result or emptying the field, so tapping
          // anywhere else left an absolutely-positioned list sitting over the
          // cards. A press on the panel itself is exempt -- see
          // `keepFieldFocused` above.
          onBlur={() => setOpen(false)}
          placeholder="Search products, people, bills…"
          placeholderTextColor={theme.bentoMuted2}
          style={styles.input}
          returnKeyType="search"
          autoCorrect={false}
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear search" hitSlop={8}>
            <Text style={styles.clear}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {showPanel ? (
        <View style={styles.panel} {...keepFieldFocused}>
          {loading && results.length === 0 ? (
            <View style={styles.state}>
              <ActivityIndicator size="small" color={theme.bentoMuted} />
            </View>
          ) : results.length === 0 ? (
            <Text style={styles.empty}>No matches for “{query.trim()}”.</Text>
          ) : (
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {results.map((result) => (
                <Pressable
                  key={`${result.kind}-${result.id}`}
                  // A plain onPress: the panel holds focus in the field while
                  // the pointer is down, so nothing unmounts this row mid-press.
                  // Press-IN would fire on mouse-down instead, which selects on
                  // an accidental brush and gives the reader no way to slide off
                  // and cancel.
                  onPress={() => {
                    setOpen(false);
                    setQuery('');
                    onSelect(result);
                  }}
                  style={styles.row}
                >
                  <Text style={styles.rowIcon}>{KIND_ICON[result.kind]}</Text>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {result.title}
                    </Text>
                    {result.subtitle ? (
                      <Text style={styles.rowSub} numberOfLines={1}>
                        {result.subtitle}
                      </Text>
                    ) : null}
                  </View>
                  {/* The type is named, not just iconified: an emoji alone
                      does not tell a reader whether a hit is a bill or an
                      expense, and those two look alike in a list. */}
                  <Text style={styles.rowKind}>{KIND_LABEL[result.kind]}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minWidth: 180, maxWidth: 340, zIndex: 20 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.bentoSoft,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  icon: { fontSize: 13 },
  input: { flex: 1, fontSize: 13, color: theme.bentoInk, padding: 0 },
  clear: { fontSize: 13, color: theme.bentoMuted, paddingHorizontal: 2 },
  panel: {
    position: 'absolute',
    top: 44,
    left: 0,
    right: 0,
    backgroundColor: theme.bentoSurface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    paddingVertical: 6,
    // Lifts the panel above the cards beneath it. `boxShadow` rather than the
    // `shadow*` props, which RN 0.86 deprecates and warns about on web;
    // `elevation` is still what Android reads.
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.12)',
    elevation: 8,
  },
  list: { maxHeight: 320 },
  state: { paddingVertical: 18, alignItems: 'center' },
  empty: { fontSize: 12.5, color: theme.bentoMuted, padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 14 },
  rowIcon: { fontSize: 14, width: 20, textAlign: 'center' },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 13.5, fontWeight: '700', color: theme.bentoInk },
  rowSub: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 1 },
  rowKind: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: theme.bentoMuted,
    backgroundColor: theme.bentoSoft,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
});
