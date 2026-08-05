import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/badge';
import { decideTimeOffRequest } from '@/lib/time-off';
import type { StaffMember, TimeOffRequest } from '@/types/models';

// The roster's time-off inbox, inline rather than behind a modal.
//
// It used to be a grey bar reading "Time off requests" with a pending count and
// nothing else -- you had to open a modal to find out whether the one pending
// request was Hodan asking for Thursday or three people asking for the same
// week. The common case is one request, so that one is shown with its
// Approve/Deny buttons live and needs no expansion at all; the rest are one tap
// away in the same place, instead of a screen away.

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
        <Badge label={request.status === 'approved' ? 'Approved' : 'Denied'} tone={request.status === 'approved' ? 'success' : 'danger'} />
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
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameFor = (shopMemberId: string) => staff.find((m) => m.id === shopMemberId)?.fullName ?? 'Staff member';
  const pending = requests.filter((r) => r.status === 'pending');
  // The newest pending one is what an approver came here for. With none
  // pending, the newest decided request still says more than an empty box.
  const preview = pending[0] ?? requests[0] ?? null;
  const others = requests.length - 1;

  const decide = async (id: string, decision: 'approved' | 'denied') => {
    setError(null);
    try {
      await decideTimeOffRequest(id, decision);
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  if (requests.length === 0) {
    return (
      <View style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Time off requests</Text>
          <Badge label="All clear" />
        </View>
        <Text style={styles.empty}>No time off requests yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Pressable onPress={() => setExpanded((open) => !open)} style={styles.head}>
        <Text style={styles.title}>Time off requests</Text>
        <View style={styles.headRight}>
          <Badge
            label={pending.length > 0 ? `${pending.length} pending` : 'All clear'}
            tone={pending.length > 0 ? 'warning' : 'default'}
          />
          {requests.length > 1 && (
            <Text style={styles.toggle}>{expanded ? 'Hide ▴' : `Show all (${requests.length}) ▾`}</Text>
          )}
        </View>
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}

      {expanded ? (
        // Capped so a shop with a long history can't push the roster off the
        // screen -- the panel scrolls, the page doesn't.
        <ScrollView style={styles.list}>
          {requests.map((request) => (
            <TimeOffRequestRow key={request.id} request={request} name={nameFor(request.shopMemberId)} onDecide={decide} />
          ))}
        </ScrollView>
      ) : (
        preview && (
          <>
            <TimeOffRequestRow request={preview} name={nameFor(preview.shopMemberId)} onDecide={decide} />
            {others > 0 && <Text style={styles.more}>+ {others} more</Text>}
          </>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#F7F7F7', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12, marginBottom: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  headRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 12.5, fontWeight: '700', color: '#111111' },
  toggle: { fontSize: 11.5, fontWeight: '700', color: '#666666' },
  list: { maxHeight: 280, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, paddingTop: 12, marginTop: 8, borderTopWidth: 1, borderTopColor: '#E6E6E6' },
  rowMain: { flex: 1, gap: 2 },
  name: { fontSize: 13, fontWeight: '700', color: '#111111' },
  range: { fontSize: 12, color: '#444444' },
  reason: { fontSize: 11.5, color: '#999999' },
  requested: { fontSize: 10.5, color: '#B0B0B0', marginTop: 2 },
  actions: { alignItems: 'flex-end', gap: 8 },
  approve: { fontSize: 12.5, fontWeight: '700', color: '#2E7D46' },
  deny: { fontSize: 12.5, fontWeight: '700', color: '#B23B4E' },
  more: { fontSize: 11.5, fontWeight: '600', color: '#999999', marginTop: 10 },
  empty: { fontSize: 12, color: '#999999', marginTop: 10 },
  error: { color: '#C0392B', fontSize: 12, fontWeight: '700', marginTop: 10 },
});
