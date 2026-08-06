import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/badge';
import { ListCard } from '@/components/ui/list-card';
import { Colors } from '@/constants/theme';
import { decideTimeOffRequest } from '@/lib/time-off';
import type { StaffMember, TimeOffRequest } from '@/types/models';

// Pinned to the light palette for now — no dark-mode switching yet. Only the
// People roster renders this, and People is a bento screen.
const theme = Colors.light;

// The roster's time-off inbox.
//
// It used to be a grey bar reading "Time off requests" with a pending count and
// nothing else -- you had to open a modal to find out whether the one pending
// request was Hodan asking for Thursday or three people asking for the same
// week. Now the newest couple of requests preview with their Approve/Deny
// buttons live, and the rest are one tap away in the same card's modal,
// instead of a screen away.

function formatDay(date: string): string {
  return new Date(date).toLocaleDateString();
}

// Non-contiguous ranges are the point of dateRanges -- "the 3rd, and the 8th to
// the 10th" is one request, and collapsing it to "3rd - 10th" (which the modal
// did) claims someone is away for a week when they asked for four days.
function rangeLines(request: TimeOffRequest): string[] {
  if (request.dateRanges && request.dateRanges.length > 0) {
    return request.dateRanges.map((range) =>
      range.startDate === range.endDate ? formatDay(range.startDate) : `${formatDay(range.startDate)} – ${formatDay(range.endDate)}`
    );
  }
  return [request.startDate === request.endDate ? formatDay(request.startDate) : `${formatDay(request.startDate)} – ${formatDay(request.endDate)}`];
}

function TimeOffRequestRow({
  request,
  name,
  onDecide,
}: {
  request: TimeOffRequest;
  name: string;
  onDecide: (id: string, decision: 'approved' | 'denied') => Promise<void>;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.name}>{name}</Text>
        {rangeLines(request).map((line) => (
          <Text key={line} style={styles.range}>
            {line}
          </Text>
        ))}
        {request.reason ? <Text style={styles.reason}>{request.reason}</Text> : null}
        <Text style={styles.requested}>Requested {formatDay(request.requestedAt)}</Text>
      </View>
      {request.status === 'pending' ? (
        <View style={styles.actions}>
          <Pressable onPress={() => onDecide(request.id, 'approved')} hitSlop={6}>
            <Text style={styles.approve}>Approve</Text>
          </Pressable>
          <Pressable onPress={() => onDecide(request.id, 'denied')} hitSlop={6}>
            <Text style={styles.deny}>Deny</Text>
          </Pressable>
        </View>
      ) : (
        <Badge variant="bento" label={request.status === 'approved' ? 'Approved' : 'Denied'} tone={request.status === 'approved' ? 'success' : 'danger'} />
      )}
    </View>
  );
}

export function TimeOffRequestsPanel({
  requests,
  staff,
  onChange,
}: {
  // Already ordered requested_at desc by listShopTimeOffRequests.
  requests: TimeOffRequest[];
  staff: StaffMember[];
  onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const nameFor = (shopMemberId: string) => staff.find((m) => m.id === shopMemberId)?.fullName ?? 'Staff member';
  const pending = requests.filter((r) => r.status === 'pending');

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setError(null);
    try {
      await decideTimeOffRequest(id, decision);
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <View style={styles.wrap}>
      {error && <Text style={styles.error}>{error}</Text>}
      <ListCard
        title="Time off requests"
        actions={
          <Badge variant="bento" label={pending.length > 0 ? `${pending.length} pending` : 'All clear'} tone={pending.length > 0 ? 'warning' : 'default'} />
        }
        rows={requests}
        keyExtractor={(request) => request.id}
        emptyLabel="No time off requests yet."
        renderRow={(request) => <TimeOffRequestRow request={request} name={nameFor(request.shopMemberId)} onDecide={decide} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Spacing where the old inline card used to sit above the roster card in
  // the list pane.
  wrap: { marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingTop: 12, marginTop: 8, borderTopWidth: 1, borderTopColor: theme.bentoLine },
  rowMain: { flex: 1, gap: 2 },
  name: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  range: { fontSize: 12, color: theme.bentoInk2 },
  reason: { fontSize: 11.5, color: theme.bentoMuted },
  requested: { fontSize: 10.5, color: theme.bentoMuted2, marginTop: 2 },
  actions: { alignItems: 'flex-end', gap: 8 },
  // Kept as words, not colour alone: "Approve" and "Deny" are the label AND
  // the signal, so the green/red pair never has to carry the meaning by itself.
  approve: { fontSize: 12.5, fontWeight: '700', color: '#0B6B3C' },
  deny: { fontSize: 12.5, fontWeight: '700', color: '#B23B4E' },
  error: { color: theme.bentoLoss, fontSize: 12, fontWeight: '700', marginBottom: 8 },
});
