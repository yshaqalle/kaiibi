import { StyleSheet, Text, View } from 'react-native';

import { BentoCard } from '@/components/ui/bento-card';
import { Colors } from '@/constants/theme';
import { formatAccountingCents } from '@/lib/currency';

const theme = Colors.light;

export type LeaderboardEntry = { name: string; valueCents: number; meta?: string };

/**
 * Who is behind the numbers — the same card for staff and for customers.
 *
 * The avatar strip is the picture; the rows under it are the data. The
 * reference this came from put the figures in a hover title and nothing else,
 * which on a phone means the ranking cannot be read at all. The strip earns
 * its place by making first place obvious at a glance, not by being the only
 * place the numbers live.
 *
 * `scope` is not optional on purpose. These two cards look identical and
 * measure different windows — staff sales follow the date range, customer
 * spend is lifetime — and two identical strips over different windows is the
 * easiest way for this screen to mislead.
 */
export function LeaderboardCard({
  title,
  scope,
  entries,
  emptyLabel,
  foot,
}: {
  title: string;
  scope: string;
  entries: LeaderboardEntry[];
  emptyLabel: string;
  foot?: string;
}) {
  const ranked = [...entries].sort((a, b) => b.valueCents - a.valueCents);
  const total = ranked.reduce((sum, entry) => sum + entry.valueCents, 0);

  return (
    <BentoCard title={title} scope={scope}>
      {ranked.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : (
        <>
          <View style={styles.strip}>
            {ranked.slice(0, 6).map((entry, index) => (
              <View
                key={entry.name}
                style={[
                  styles.avatar,
                  index > 0 && styles.avatarOverlap,
                  index === 0 && styles.avatarLead,
                  // Earlier avatars sit on top, so the leader is never the one
                  // half-covered by the person below them.
                  { zIndex: ranked.length - index },
                ]}
              >
                <Text style={styles.initials}>{initialsOf(entry.name)}</Text>
                <View style={[styles.badge, index === 0 && styles.badgeLead]}>
                  <Text style={[styles.badgeText, index === 0 && styles.badgeTextLead]}>{index + 1}</Text>
                </View>
              </View>
            ))}
          </View>

          <View style={styles.rows}>
            {ranked.map((entry, index) => (
              <View key={entry.name} style={[styles.row, index === ranked.length - 1 && styles.rowLast]}>
                <Text style={styles.name} numberOfLines={1}>
                  {entry.name}
                  {entry.meta ? <Text style={styles.meta}>{`  ${entry.meta}`}</Text> : null}
                </Text>
                <Text style={styles.value}>{formatAccountingCents(entry.valueCents)}</Text>
              </View>
            ))}
          </View>

          {total > 0 ? (
            <Text style={styles.foot}>
              {`${ranked[0].name} leads with ${((ranked[0].valueCents / total) * 100).toFixed(0)}% of the total shown.` +
                (foot ? ` ${foot}` : '')}
            </Text>
          ) : null}
        </>
      )}
    </BentoCard>
  );
}

// Two letters at most. A three-initial avatar at 46px sets the type small
// enough that the letters stop being legible, which defeats the point.
function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: theme.bentoInk,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: theme.bentoSurface,
  },
  avatarOverlap: { marginLeft: -12 },
  avatarLead: { backgroundColor: theme.bentoSeries1 },
  initials: { fontSize: 13.5, fontWeight: '800', color: '#ffffff' },
  badge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: theme.bentoSoft,
    borderWidth: 2,
    borderColor: theme.bentoSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeLead: { backgroundColor: theme.bentoSeries1 },
  badgeText: { fontSize: 9.5, fontWeight: '800', color: theme.bentoInk2, fontVariant: ['tabular-nums'] },
  badgeTextLead: { color: '#ffffff' },

  rows: { marginTop: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.bentoLine,
  },
  rowLast: { borderBottomWidth: 0 },
  name: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600', color: theme.bentoInk },
  meta: { fontWeight: '400', color: theme.bentoMuted, fontSize: 11.5 },
  value: { fontSize: 13, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  foot: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 12, lineHeight: 17 },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 4 },
});
