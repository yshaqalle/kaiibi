import { Fragment, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EmailButton, NoContact, WhatsAppButton } from '@/components/platform/whatsapp-button';
import { Colors } from '@/constants/theme';
import { branchAccessLabel, sortPeople, type Branch, type ShopPerson } from '@/lib/shop-people';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

// One person, and one branch. Rules between rows rather than a bordered box
// each, the same way the Overview's attention list is built: the card is
// already the container.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function PersonRow({
  person,
  branchCount,
  expanded,
  onToggle,
  first,
}: {
  person: ShopPerson;
  branchCount: number;
  expanded: boolean;
  onToggle: () => void;
  first: boolean;
}) {
  const where = branchAccessLabel(person, branchCount);
  // Contact details are not offered for someone who has left. They are still
  // in the store's own records; this console has no reason to reach them.
  const reachable = person.active;
  return (
    <View>
      <Pressable
        onPress={onToggle}
        style={[styles.row, first && styles.rowFirst]}
        aria-expanded={expanded}
        aria-label={`${person.name}, ${person.roleName}`}
      >
        <View style={[styles.avatar, person.isOwner && styles.avatarOwner]}>
          <Text style={[styles.avatarText, person.isOwner && styles.avatarTextOwner]}>{initials(person.name)}</Text>
        </View>
        <View style={styles.main}>
          <View style={styles.titleRow}>
            <Text style={[styles.name, !person.active && styles.dim]} numberOfLines={1}>
              {person.name}
            </Text>
            <View style={[styles.pill, person.isOwner && styles.pillOwner, !person.active && styles.pillOff]}>
              <Text style={[styles.pillText, person.isOwner && styles.pillTextOwner]}>{person.roleName}</Text>
            </View>
            {where ? (
              <View style={[styles.pill, styles.pillWhere]}>
                <Text style={[styles.pillText, styles.pillTextWhere]}>{where}</Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.line, !person.active && styles.dim]} numberOfLines={1}>
            {reachable
              ? [person.email, person.phone ?? 'no phone on file'].filter(Boolean).join(' · ')
              : `signed up ${person.joinedAt.slice(0, 10)}`}
          </Text>
        </View>
        <View style={styles.actions}>
          {reachable ? (
            <>
              <WhatsAppButton
                phone={person.phone}
                message={`Hi ${person.name.split(' ')[0]} — this is Kaiibi.`}
                label={`WhatsApp ${person.name}`}
              />
              <EmailButton email={person.email} label={`Email ${person.name}`} />
            </>
          ) : (
            <NoContact />
          )}
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.detail}>
          <Detail label="Role" value={person.isOwner ? `${person.roleName} — full authority` : person.roleName} />
          <Detail
            label="Works at"
            value={
              person.isOwner
                ? 'Every branch — always, by ownership'
                : person.branchNames.length === 0
                  ? 'Every branch — no assignment set'
                  : person.branchNames.join(', ')
            }
          />
          <Detail label="Signed up" value={person.joinedAt.slice(0, 10)} />
          {person.active ? (
            <>
              <Detail label="Email" value={person.email ?? 'none on file'} />
              <Detail label="Phone" value={person.phone ?? 'none on file — WhatsApp is not offered'} />
            </>
          ) : (
            <Detail label="Contact" value="withheld while inactive" />
          )}
          {person.permissions.length > 0 ? (
            <Text style={styles.perms}>{`Their role allows: ${person.permissions.join(', ')}`}</Text>
          ) : null}
          <Text style={styles.never}>
            Not shown, and not returned by the query at all: pay, hire date, photo, shifts, or anything they have
            recorded.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailKey}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

export function BranchRow({ branch, first }: { branch: Branch; first: boolean }) {
  const place = [branch.neighborhood, branch.city].filter(Boolean).join(', ');
  return (
    <View style={[styles.row, first && styles.rowFirst]}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>◎</Text>
      </View>
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>
            {branch.name}
          </Text>
          {branch.isPrimary ? (
            <View style={styles.pill}>
              <Text style={styles.pillText}>Main</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.line} numberOfLines={1}>
          {[place || 'no address on file', branch.phone ?? 'no phone on file'].join(' · ')}
        </Text>
      </View>
      <View style={styles.actions}>
        <WhatsAppButton
          phone={branch.phone}
          message={`Hi — this is Kaiibi, about ${branch.name}.`}
          label={`WhatsApp ${branch.name}`}
        />
      </View>
    </View>
  );
}

/**
 * The whole roster, grouped by whether someone still works there.
 *
 * Two headings rather than a status column: "Working here" is who you can talk
 * to, and "No longer here" answers "I spoke to Cabdi in June, what happened?"
 */
export function PeopleGroups({ people, branchCount }: { people: ShopPerson[]; branchCount: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = sortPeople(people);
  const here = sorted.filter((p) => p.active);
  const gone = sorted.filter((p) => !p.active);

  const group = (label: string, list: ShopPerson[]) =>
    list.length === 0 ? null : (
      <Fragment key={label}>
        <Text style={styles.groupLabel}>{label}</Text>
        {list.map((person, i) => (
          <PersonRow
            key={person.userId}
            person={person}
            branchCount={branchCount}
            expanded={open === person.userId}
            onToggle={() => setOpen(open === person.userId ? null : person.userId)}
            first={i === 0}
          />
        ))}
      </Fragment>
    );

  return (
    <View>
      {group('Working here', here)}
      {group('No longer here', gone)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: theme.bentoRule,
  },
  rowFirst: { borderTopWidth: 0 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: theme.bentoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOwner: { backgroundColor: theme.bentoInk },
  avatarText: { fontSize: 12, fontWeight: '800', color: theme.bentoMuted },
  avatarTextOwner: { color: theme.bentoSurface },
  main: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  name: { fontSize: 13.5, fontWeight: '800', color: theme.bentoInk, flexShrink: 1 },
  line: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  dim: { opacity: 0.6 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 7 },

  pill: { backgroundColor: theme.bentoSoft, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 },
  pillOwner: { backgroundColor: theme.bentoInk },
  pillOff: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.bentoRule },
  pillWhere: { backgroundColor: theme.bentoAccentWash },
  pillText: { fontSize: 10, fontWeight: '800', color: theme.bentoMuted2 },
  pillTextOwner: { color: theme.bentoSurface },
  pillTextWhere: { color: theme.bentoAccentInk },

  groupLabel: {
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: theme.bentoMuted2,
    marginTop: 14,
    marginBottom: 4,
  },

  detail: { backgroundColor: theme.bentoSoft, borderRadius: 16, padding: 13, marginBottom: 8 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 14, paddingVertical: 3 },
  detailKey: { fontSize: 12, color: theme.bentoMuted },
  detailValue: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2, flexShrink: 1, textAlign: 'right' },
  perms: { fontSize: 11, color: theme.bentoMuted, marginTop: 8, lineHeight: 16 },
  never: { fontSize: 11, color: theme.bentoMuted2, marginTop: 8, lineHeight: 16 },
});
