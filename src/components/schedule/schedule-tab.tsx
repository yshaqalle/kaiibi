import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { TABLET_BREAKPOINT } from '@/constants/layout';
import { Colors } from '@/constants/theme';
import { useHeaderActions, type HeaderActionsSetter } from '@/components/accounting/use-header-actions';
import { CsvImportModal, type ImportEntityConfig } from '@/components/csv-import-modal';
import { ExportMenu } from '@/components/export-menu';
import { BulkShiftModal } from '@/components/schedule/bulk-shift-modal';
import { ShiftEditorModal } from '@/components/schedule/shift-editor-modal';
import { BentoCard } from '@/components/ui/bento-card';
import {
  addDaysToDate,
  membersForLocation,
  shiftMinutes,
  shiftsToCopy,
  startOfWeek,
  weekDaysFrom,
  type Shift,
  type ShiftDraft,
} from '@/lib/scheduling';
import { hasMultipleLocations } from '@/lib/location-selection';
import { SCHEDULE_EXAMPLE_ROWS, SCHEDULE_TEMPLATE_COLUMNS, scheduleTemplateRows } from '@/lib/schedule-import';
import { createShift, createShifts, deleteShift, listShiftsForWeek, runScheduleImport, updateShift } from '@/lib/shifts';
import type { CsvColumn } from '@/lib/csv';
import { onLeaveMemberIds } from '@/lib/shift-hours';
import { listShopApprovedTimeOff } from '@/lib/time-off';
import { listStaff } from '@/lib/staff';
import { fromDateColumn, toDateColumn } from '@/lib/period';
import type { StaffMember } from '@/types/models';
import { AppModal } from '@/components/ui/app-modal';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';

// Pinned to the light palette for now — no dark-mode switching yet.
const theme = Colors.light;

function dayLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

// The phone shows ONE day at a time, so its date control has to say which day
// it is in words -- "05/08" alone leaves you counting which weekday that was.
function longDayLabel(date: string): string {
  return fromDateColumn(date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function totalHours(shifts: Shift[]): string {
  const minutes = shifts.reduce((sum, shift) => sum + shiftMinutes(shift), 0);
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`;
}

export function ScheduleTab({ setHeaderActions }: { setHeaderActions: HeaderActionsSetter }) {
  const { shop, locations, activeLocation } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < TABLET_BREAKPOINT;

  // Which store's week is on screen. null is "All stores". Defaults to the
  // active store, because planning is something you do for one counter at a
  // time -- the flat shop-wide board was unreadable once a second store
  // existed.
  const [locationId, setLocationId] = useState<string | null>(() => activeLocation?.id ?? null);
  const [monday, setMonday] = useState(() => startOfWeek(toDateColumn(new Date())));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [selectedDay, setSelectedDay] = useState(() => toDateColumn(new Date()));
  // Tracks the FIRST fetch, not every fetch. `reload()` runs again after each
  // edit here, and swapping the rendered rows for a placeholder on those
  // collapsed the scroll content to a few pixels -- the platform then clamps
  // the scroll offset to fit, so the list came back at the top and whoever was
  // reading it lost their place after every change. Gating on "has anything
  // arrived yet" keeps the rows mounted, so they keep their height and their
  // position, and the values update underneath. First found in inventory.tsx.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ date: string; shift: Shift | null; memberId: string | null } | null>(null);
  // Phone only. The occasional actions live behind one pill on the title row
  // rather than in a row under the board: a roster of any real size pushes a
  // bottom row past the fold, and an action you have to scroll a staff list to
  // reach may as well not be there.
  const [showMore, setShowMore] = useState(false);
  const [timeOff, setTimeOff] = useState<Awaited<ReturnType<typeof listShopApprovedTimeOff>>>([]);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);

  const reload = useCallback(async () => {
    if (!shop) return;
    try {
      const [weekShifts, staff, requests] = await Promise.all([
        listShiftsForWeek(shop.id, monday),
        listStaff(shop.id),
        listShopApprovedTimeOff(shop.id, { start: monday, end: addDaysToDate(monday, 6) }),
      ]);
      setShifts(weekShifts);
      setMembers(staff.filter((member) => member.active));
      setTimeOff(requests);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the schedule.');
    } finally {
      setLoaded(true);
    }
  }, [shop, monday]);

  useEffect(() => { reload(); }, [reload]);
  // Coming back to this screen on a phone, where the tab shell never unmounted
  // it, so its data is as old as the last time it was looked at.
  useRefreshOnFocus(reload);

  // One draft edits in place; two or more are a split day, which is several
  // rows -- the schema has no "split shift", only shifts that share a date.
  const saveShift = async (drafts: ShiftDraft[], note: string | null) => {
    if (!shop || drafts.length === 0) return;
    if (editing?.shift) {
      const [draft] = drafts;
      await updateShift(editing.shift.id, { date: draft.date, start: draft.start, end: draft.end, note });
    } else if (drafts.length === 1) {
      await createShift(shop.id, drafts[0], note);
    } else {
      await createShifts(shop.id, drafts.map((draft) => ({ ...draft, note })));
    }
    setEditing(null);
    await reload();
  };

  const removeShift = async () => {
    if (!editing?.shift) return;
    await deleteShift(editing.shift.id);
    setEditing(null);
    await reload();
  };

  // Reports both counts rather than silently doing partial work: an owner who
  // asked to copy a week needs to know which shifts didn't make it.
  const copyLastWeek = async () => {
    if (!shop) return;
    setCopyNotice(null);
    try {
      const lastWeek = await listShiftsForWeek(shop.id, addDaysToDate(monday, -7));
      // Copies only what is on screen. Copying every store's shifts from a view
      // filtered to one store would do more than the screen shows, which is the
      // kind of surprise an undo button doesn't fix.
      const previous = locationId ? lastWeek.filter((shift) => shift.locationId === locationId) : lastWeek;
      const { copy, skipped } = shiftsToCopy(previous, visibleShifts);
      const created = await createShifts(shop.id, copy);
      const where = locationId ? ` to ${storeName(locationId)}` : '';
      // "Copied 0" alone reads as an unexplained no-op, which is the ambiguity
      // this notice exists to remove -- so an empty source week says so.
      setCopyNotice(
        previous.length === 0
          ? `Last week had no shifts${locationId ? ` at ${storeName(locationId)}` : ''} to copy.`
          : skipped === 0
            ? `Copied ${created} shift${created === 1 ? '' : 's'} from last week${where}.`
            : `Copied ${created}${where}, skipped ${skipped} that clashed with a shift already here.`
      );
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy last week.');
    }
  };

  const activeLocations = locations.filter((location) => location.active);
  const multiStore = hasMultipleLocations(locations);
  // Filtered here rather than in the query: the week is a single fetch, and
  // copy-last-week needs to reason about it as a whole.
  const visibleShifts = locationId ? shifts.filter((shift) => shift.locationId === locationId) : shifts;
  const visibleMembers = membersForLocation(members, locationId);
  const storeName = (id: string) => locations.find((location) => location.id === id)?.name ?? '';

  // Deliberately the same headers, in the same order, as
  // SCHEDULE_TEMPLATE_COLUMNS: export a week, edit it in a spreadsheet, import
  // it back. A format you can only write by hand isn't one people use.
  const exportColumns: CsvColumn<Shift>[] = [
    { header: 'Date', value: (shift) => shift.date },
    { header: 'Staff Name', value: (shift) => members.find((m) => m.id === shift.shopMemberId)?.fullName ?? '' },
    { header: 'Staff Email', value: (shift) => members.find((m) => m.id === shift.shopMemberId)?.email ?? '' },
    { header: 'Start', value: (shift) => shift.start },
    { header: 'End', value: (shift) => shift.end },
    { header: 'Store', value: (shift) => storeName(shift.locationId) },
    { header: 'Note', value: (shift) => shift.note ?? '' },
  ];

  // The template is this week's rota with the times taken out: the people on
  // the board, against the days on the board, at the store the board is
  // showing. Falls back to the documented example only when there is nobody to
  // build it from -- a shop that has not added anyone yet, or one whose people
  // here are all inactive (scheduleTemplateRows leaves those out, so the check
  // is on the rows it produced, not on the roster it was handed).
  //
  // Not gated on `members.length > 0` any more. It was, and since the modal is
  // only mounted when this is non-null, pressing Import with an empty roster
  // did nothing at all -- no modal, no message, no way to tell it had been
  // pressed.
  const days = weekDaysFrom(monday);
  // The store cell is resolved per member inside scheduleTemplateRows -- one
  // name stamped on everyone bounced restricted staff off their own template.
  const templateRows = scheduleTemplateRows(visibleMembers, days, { locationId, locations });
  const importConfig: ImportEntityConfig<ShiftDraft> | null = shop
    ? {
        title: 'schedule',
        filenamePrefix: 'schedule',
        templateColumns: SCHEDULE_TEMPLATE_COLUMNS,
        exampleRows: templateRows.length > 0 ? templateRows : SCHEDULE_EXAMPLE_ROWS,
        run: (parsed) => runScheduleImport(shop.id, parsed, { members, locations }),
        unitLabel: 'shift',
      }
    : null;

  // selectedDay is only ever moved by tapping a day chip -- paging the week
  // with ‹ / › re-anchors `days` but leaves selectedDay wherever it was, so a
  // stored value from a previous week would silently point outside the week
  // now on screen. Deriving the effective day here (rather than reconciling
  // the state itself, which would need an effect the lint budget doesn't
  // allow) keeps every read of "the selected day" honest without one.
  const effectiveSelectedDay = days.includes(selectedDay) ? selectedDay : days[0];
  const shiftsFor = (memberId: string, date: string) =>
    visibleShifts.filter((shift) => shift.shopMemberId === memberId && shift.date === date);
  // Drives the phone card's scope pill -- "6h scheduled" says more about the day
  // than a headcount does, since the point of opening it is the coverage.
  const shiftsOnSelectedDay = visibleShifts.filter((shift) => shift.date === effectiveSelectedDay);

  // Export/Import/Add are SCREEN actions and go up to the shell's title row.
  // The date control below stays in the body: it acts on the board underneath
  // it, and moving it into the header would separate it from the thing it moves.
  //
  // On a phone only the ONE primary action goes up. Four solid black pills in a
  // row is most of a phone screen, and it makes four things look equally
  // primary, which drains the black of the meaning it carries everywhere else.
  // Export and Import move below the board, where they read as the occasional
  // actions they are.
  useHeaderActions(
    setHeaderActions,
    compact ? (
      <>
        <Pressable onPress={() => setShowMore(true)} style={styles.navButton} accessibilityLabel="More schedule actions">
          <Text style={styles.navText}>More</Text>
        </Pressable>
        <Pressable onPress={() => setShowBulkModal(true)} style={[styles.navButton, styles.navButtonSolid]}>
          <Text style={[styles.navText, styles.navTextSolid]}>+ Add shifts</Text>
        </Pressable>
      </>
    ) : (
      <>
        <ExportMenu
          rows={visibleShifts}
          columns={exportColumns}
          title="Schedule"
          subtitle={`${dayLabel(days[0])} – ${dayLabel(days[6])}${locationId ? ` · ${storeName(locationId)}` : ''}`}
          filenamePrefix="schedule"
        />
        <Pressable onPress={() => setShowImportModal(true)} style={styles.navButton}>
          <Text style={styles.navText}>Import</Text>
        </Pressable>
        <Pressable onPress={() => setShowBulkModal(true)} style={[styles.navButton, styles.navButtonSolid]}>
          <Text style={[styles.navText, styles.navTextSolid]}>+ Add shifts</Text>
        </Pressable>
      </>
    ),
    // The state these are all derived from, not the derived values:
    // `visibleShifts`, `exportColumns` and `days` are rebuilt on every render,
    // so depending on them would re-publish the actions every render and loop
    // against the shell that stores them.
    [shifts, locationId, monday, locations, compact]
  );

  // Phone stepping is by DAY, not by week: the board below shows one day, so a
  // week pager plus a day picker was two controls doing one job -- and two rows
  // of chrome for it. Moving the week with it means crossing Sunday just works.
  const stepDay = (delta: number) => {
    const next = addDaysToDate(effectiveSelectedDay, delta);
    setSelectedDay(next);
    setMonday(startOfWeek(next));
  };
  const goToToday = () => {
    const today = toDateColumn(new Date());
    setSelectedDay(today);
    setMonday(startOfWeek(today));
  };

  return (
    <View>
      <View style={styles.header}>
        {compact ? (
          <View style={styles.dayNav}>
            <Pressable onPress={() => stepDay(-1)} style={styles.navButton} accessibilityLabel="Previous day">
              <Text style={styles.navText}>‹</Text>
            </Pressable>
            <Text style={styles.dayNavLabel} numberOfLines={1}>{longDayLabel(effectiveSelectedDay)}</Text>
            <Pressable onPress={() => stepDay(1)} style={styles.navButton} accessibilityLabel="Next day">
              <Text style={styles.navText}>›</Text>
            </Pressable>
            <Pressable onPress={goToToday} style={styles.navButton}>
              <Text style={styles.navText}>Today</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.weekNav}>
            <Pressable onPress={() => setMonday(addDaysToDate(monday, -7))} style={styles.navButton}>
              <Text style={styles.navText}>‹</Text>
            </Pressable>
            <Text style={styles.weekLabel}>{dayLabel(days[0])} – {dayLabel(days[6])}</Text>
            <Pressable onPress={() => setMonday(addDaysToDate(monday, 7))} style={styles.navButton}>
              <Text style={styles.navText}>›</Text>
            </Pressable>
            <Pressable onPress={goToToday} style={styles.navButton}>
              <Text style={styles.navText}>Today</Text>
            </Pressable>
            <Pressable onPress={copyLastWeek} style={styles.navButton}>
              <Text style={styles.navText}>Copy last week</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Only when there is a choice to make -- a single-store business has one
          answer and this row would say nothing. */}
      {multiStore && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.storeStrip}>
          <Pressable onPress={() => setLocationId(null)} style={[styles.storeChip, locationId === null && styles.storeChipActive]}>
            <Text style={[styles.storeChipText, locationId === null && styles.storeChipTextActive]}>All stores</Text>
          </Pressable>
          {activeLocations.map((location) => (
            <Pressable
              key={location.id}
              onPress={() => setLocationId(location.id)}
              style={[styles.storeChip, locationId === location.id && styles.storeChipActive]}
            >
              <Text style={[styles.storeChipText, locationId === location.id && styles.storeChipTextActive]}>{location.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
      {copyNotice && <Text style={styles.notice}>{copyNotice}</Text>}

      {!loaded ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : visibleMembers.length === 0 ? (
        <Text style={styles.empty}>
          {members.length === 0
            ? 'No active staff to schedule.'
            : `No staff can work at ${locationId ? storeName(locationId) : 'this store'} yet — assign someone to it in Team.`}
        </Text>
      ) : compact ? (
        <>
          <BentoCard title={longDayLabel(effectiveSelectedDay)} scope={`${totalHours(shiftsOnSelectedDay)} scheduled`}>
          {visibleMembers.map((member) => {
            const memberShifts = shiftsFor(member.id, effectiveSelectedDay);
            return (
              <View key={member.id} style={styles.listRow}>
                <Text style={styles.memberName}>{member.fullName ?? 'Staff member'}</Text>
                {/* Each block is its own tap target, so a split day can be
                    edited one half at a time -- and `+ Add` is what makes the
                    second half reachable at all. */}
                <View style={styles.listRowRight}>
                  {memberShifts.length === 0 ? (
                    <Pressable onPress={() => setEditing({ date: effectiveSelectedDay, shift: null, memberId: member.id })}>
                      <Text style={styles.off}>Off</Text>
                    </Pressable>
                  ) : (
                    // The same block the desktop board uses, so a shift looks
                    // like a shift on either size.
                    memberShifts.map((shift) => (
                      <Pressable
                        key={shift.id}
                        onPress={() => setEditing({ date: effectiveSelectedDay, shift, memberId: member.id })}
                        style={styles.shiftBlock}
                      >
                        <Text style={styles.shiftTime}>{`${shift.start}–${shift.end}`}</Text>
                        {!locationId && multiStore && (
                          <Text style={styles.shiftStore} numberOfLines={1}>{storeName(shift.locationId)}</Text>
                        )}
                      </Pressable>
                    ))
                  )}
                  <Pressable
                    accessibilityLabel={`Add a shift for ${member.fullName ?? 'this person'}`}
                    onPress={() => setEditing({ date: effectiveSelectedDay, shift: null, memberId: member.id })}
                    hitSlop={10}
                    style={styles.addTarget}
                  >
                    <Text style={styles.addShift}>+</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
          </BentoCard>
        </>
      ) : (
        // One card for the whole week, deliberately not subdivided: a week is a
        // continuous object and the reason to look at it is to compare ACROSS a
        // row. Cutting it into a cell per day would break exactly that.
        <BentoCard style={styles.boardCard}>
          {/* minWidth 100% on the content lets the seven day columns share any
              width the card has spare, instead of the board hugging its
              intrinsic size and leaving half the card empty on a wide screen.
              Below that width it scrolls sideways INSIDE the card, which is the
              one nested scroll this tab genuinely needs. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boardContent}>
            <View style={styles.board}>
              <View style={[styles.gridRow, styles.gridHeadRow]}>
                <Text style={[styles.gridCell, styles.staffCell, styles.gridHeadCell]}>Staff</Text>
                {days.map((date) => (
                  <Text key={date} style={[styles.gridCell, styles.gridHeadCell]}>{dayLabel(date)}</Text>
                ))}
                <Text style={[styles.gridCell, styles.totalCell, styles.gridHeadCell, styles.alignRight]}>Total</Text>
              </View>
              {visibleMembers.map((member) => (
                <View key={member.id} style={styles.gridRow}>
                  <Text style={[styles.gridCell, styles.staffCell, styles.memberName]} numberOfLines={2}>
                    {member.fullName ?? 'Staff member'}
                  </Text>
                  {days.map((date) => {
                    const cell = shiftsFor(member.id, date);
                    return (
                      <View key={date} style={[styles.gridCell, styles.gridCellStack]}>
                        {/* A shift is a BLOCK, not a line of text. At 104px the
                            old single-line label wrapped "17:00–22:00 · Store"
                            across three lines, so a two-shift day was six lines
                            of grey and the row lost its shape. */}
                        {cell.map((shift) => (
                          <Pressable
                            key={shift.id}
                            onPress={() => setEditing({ date, shift, memberId: member.id })}
                            style={styles.shiftBlock}
                          >
                            <Text style={styles.shiftTime}>{`${shift.start}–${shift.end}`}</Text>
                            {!locationId && multiStore && (
                              <Text style={styles.shiftStore} numberOfLines={1}>
                                {storeName(shift.locationId)}
                              </Text>
                            )}
                          </Pressable>
                        ))}
                        {/* Tapping an occupied cell used to edit its FIRST shift,
                            which made a second block on the same day
                            unreachable -- this is the whole of split-day entry. */}
                        <Pressable
                          accessibilityLabel={`Add a shift for ${member.fullName ?? 'this person'}`}
                          onPress={() => setEditing({ date, shift: null, memberId: member.id })}
                          hitSlop={6}
                        >
                          <Text style={cell.length === 0 ? styles.off : styles.addShift}>{cell.length === 0 ? '—' : '+ add'}</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                  <Text style={[styles.gridCell, styles.totalCell, styles.total, styles.alignRight]}>
                    {totalHours(visibleShifts.filter((shift) => shift.shopMemberId === member.id))}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </BentoCard>
      )}

      <AppModal visible={showMore} transparent animationType="slide" onRequestClose={() => setShowMore(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => setShowMore(false)} accessibilityLabel="Close">
          {/* Stops a tap inside the sheet from closing it. */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>Schedule actions</Text>
              <Pressable onPress={() => setShowMore(false)} style={styles.navButton}>
                <Text style={styles.navText}>Close</Text>
              </Pressable>
            </View>

            <Pressable
              onPress={() => { setShowMore(false); copyLastWeek(); }}
              style={styles.sheetRow}
            >
              <Text style={styles.sheetRowLabel}>Copy last week</Text>
              <Text style={styles.sheetRowHint}>Repeats the previous week onto this one</Text>
            </Pressable>

            <Pressable
              onPress={() => { setShowMore(false); setShowImportModal(true); }}
              style={styles.sheetRow}
            >
              <Text style={styles.sheetRowLabel}>Import shifts</Text>
              <Text style={styles.sheetRowHint}>From a CSV file</Text>
            </Pressable>

            <View style={styles.sheetRow}>
              <Text style={styles.sheetRowLabel}>Export</Text>
              <Text style={styles.sheetRowHint}>
                {`This week${locationId ? ` · ${storeName(locationId)}` : ''} — ${visibleShifts.length} shift${visibleShifts.length === 1 ? '' : 's'}`}
              </Text>
              <View style={styles.sheetExport}>
                <ExportMenu
                  rows={visibleShifts}
                  columns={exportColumns}
                  title="Schedule"
                  subtitle={`${dayLabel(days[0])} – ${dayLabel(days[6])}${locationId ? ` · ${storeName(locationId)}` : ''}`}
                  filenamePrefix="schedule"
                />
              </View>
            </View>
          </Pressable>
        </Pressable>
      </AppModal>

      {showBulkModal && (
        <BulkShiftModal
          visible
          days={days}
          members={visibleMembers}
          locations={activeLocations}
          seedLocationId={locationId}
          seedDate={effectiveSelectedDay}
          // Every stored shift, not just the visible store's: someone cannot be
          // in two stores at once, so a clash is a clash wherever it is.
          existingShifts={shifts}
          onClose={() => setShowBulkModal(false)}
          onSave={async (drafts) => {
            if (!shop) return;
            await createShifts(shop.id, drafts);
            setShowBulkModal(false);
            await reload();
          }}
        />
      )}

      {importConfig && (
        <CsvImportModal visible={showImportModal} onClose={() => setShowImportModal(false)} config={importConfig} onImported={reload} />
      )}

      {editing && (
        <ShiftEditorModal
          // Keyed on the edit target so switching targets remounts rather than
          // keeping the previous shift's times: the modal seeds its state from
          // `existing` with useState, which only reads it on first mount. This
          // matches invoices-tab, cash-budgets-tab, expenses-tab and
          // taxonomy-manage-modal, which all key their editors for this reason.
          key={editing.shift ? editing.shift.id : `new-${editing.date}-${editing.memberId}`}
          visible
          date={editing.date}
          members={members}
          existing={editing.shift}
          seedMemberId={editing.memberId}
          seedLocationId={locationId}
          locations={locations.filter((location) => location.active)}
          context={{
            // A placeholder: the modal overrides this with the hours of the
            // store the shift is actually assigned to, which is the only
            // reading that means anything once two stores differ.
            hours: activeLocation?.openingHours ?? {},
            onLeave: onLeaveMemberIds(timeOff, fromDateColumn(editing.date)),
            sameDayShifts: shifts.filter((shift) => shift.date === editing.date),
          }}
          onClose={() => setEditing(null)}
          onSave={saveShift}
          onDelete={removeShift}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  weekNav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navButton: {
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  navButtonSolid: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  navText: { fontSize: 12.5, fontWeight: '700', color: theme.bentoInk2 },
  navTextSolid: { color: theme.bentoSurface },
  weekLabel: { fontSize: 13, fontWeight: '700', color: theme.bentoInk, minWidth: 104, textAlign: 'center' },
  // One row on a phone, and the date takes the space the day chips used to.
  dayNav: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  dayNavLabel: { flex: 1, fontSize: 14, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.2, textAlign: 'center' },
  // Same sheet treatment TwoPaneListDetail uses, so a sheet is a sheet
  // wherever People puts one.
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(11,11,13,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: theme.bentoPage, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, paddingBottom: 28 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: theme.bentoInk, letterSpacing: -0.3 },
  sheetRow: { backgroundColor: theme.bentoSurface, borderRadius: 16, paddingHorizontal: 15, paddingVertical: 13, marginBottom: 8 },
  sheetRowLabel: { fontSize: 14, fontWeight: '700', color: theme.bentoInk },
  sheetRowHint: { fontSize: 11.5, color: theme.bentoMuted, marginTop: 2 },
  sheetExport: { marginTop: 10 },
  addTarget: { paddingHorizontal: 6, paddingVertical: 4 },
  storeStrip: { marginBottom: 12 },
  storeChip: { backgroundColor: theme.bentoSurface, borderWidth: 1, borderColor: theme.bentoLine, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7, marginRight: 8 },
  storeChipActive: { backgroundColor: theme.bentoInk, borderColor: theme.bentoInk },
  storeChipText: { fontSize: 12, fontWeight: '700', color: theme.bentoInk2 },
  storeChipTextActive: { color: theme.bentoSurface },
  listRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  listRowRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
  addShift: { fontSize: 11, fontWeight: '700', color: theme.bentoMuted2 },
  // Less horizontal padding than a normal bento card: the board manages its
  // own column gutters, and doubling them squeezes seven days into less room.
  boardCard: { paddingHorizontal: 10, paddingVertical: 14 },
  boardContent: { minWidth: '100%' },
  board: { flexGrow: 1, minWidth: 1050 },
  gridRow: { flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 1, borderBottomColor: theme.bentoLine },
  gridHeadRow: { borderBottomColor: theme.bentoLine },
  // Day columns share whatever the card has spare, down to a floor of 116px --
  // below that "17:00–22:00" itself starts to wrap and the board scrolls instead.
  gridCell: { flexGrow: 1, flexShrink: 1, flexBasis: 116, minWidth: 116, paddingHorizontal: 8, paddingVertical: 11, fontSize: 12, color: theme.bentoInk },
  // The name and total columns are fixed: the name is the row's label, and
  // letting it flex would take room from the days that need it.
  staffCell: { flexGrow: 0, flexShrink: 0, flexBasis: 156, width: 156, minWidth: 156 },
  totalCell: { flexGrow: 0, flexShrink: 0, flexBasis: 78, width: 78, minWidth: 78 },
  alignRight: { textAlign: 'right' },
  gridCellStack: { gap: 5 },
  gridHeadCell: { fontWeight: '700', color: theme.bentoMuted, fontSize: 10.5, letterSpacing: 0.6, textTransform: 'uppercase' },
  memberName: { fontSize: 13, fontWeight: '700', color: theme.bentoInk },
  // A filled block, so a scheduled day reads as occupied at a glance and an
  // empty one as a gap -- which is the question the board is actually asked.
  shiftBlock: { backgroundColor: theme.bentoSoft, borderRadius: 11, paddingHorizontal: 8, paddingVertical: 6 },
  shiftTime: { fontSize: 11.5, fontWeight: '800', color: theme.bentoInk, fontVariant: ['tabular-nums'] },
  shiftStore: { fontSize: 10, color: theme.bentoMuted, marginTop: 1 },
  off: { color: theme.bentoMuted2, fontSize: 12 },
  total: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  empty: { fontSize: 13, color: theme.bentoMuted, paddingVertical: 24, textAlign: 'center' },
  error: { color: theme.bentoLoss, fontSize: 13, fontWeight: '700', marginBottom: 12 },
  notice: { fontSize: 12, fontWeight: '700', color: theme.bentoInk, marginBottom: 12 },
});
