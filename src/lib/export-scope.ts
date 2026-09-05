/**
 * The subtitle every exported report carries, and the only place the file
 * records what it is a view OF.
 *
 * It matters more than a subtitle usually does because the file outlives the
 * screen. A spreadsheet on somebody's desktop three weeks later has no range
 * picker and no store pill next to it, so if this line does not say which
 * fortnight and which shop, the numbers in it are unattributable.
 *
 * The `when` half is deliberately two different shapes, because the reports are
 * two different kinds of thing:
 *
 *   * A FLOW over a window -- revenue, units sold, stock movements. Its scope
 *     is the range, and it reads "1-14 Aug 2026".
 *   * A POSITION at an instant -- stock on hand, what is below its reorder
 *     point. There is no such thing as the stock a shop held over a fortnight,
 *     so these ignore the range entirely and read "As at 14 Aug 2026, 16:32".
 *
 * The distinction is not invented here: every report already declares it as
 * `followsRange` on its hub card, for exactly the same reason -- a card, or a
 * file, promising a window the report does not honour is one that gets
 * believed. Passing `rangeLabel: null` is how a caller says "position".
 *
 * The instant carries a TIME, not just a date. Stock moves during a day, so two
 * exports taken the same morning and afternoon are different documents and have
 * to be told apart.
 */
export function exportScopeLabel(opts: {
  /** The shell's range label. Null for a report that ignores the range. */
  rangeLabel: string | null;
  /** The instant a position was read. Required when `rangeLabel` is null. */
  asOf?: Date;
  /** The chosen store's name, or null for the combined business view. */
  storeName: string | null;
}): string {
  const when = opts.rangeLabel ?? (opts.asOf ? `As at ${formatInstant(opts.asOf)}` : 'As at today');
  // Never left off, even for a single-store shop. The reader of the file may
  // not be the person who took it, and "All stores" of one shop is still a
  // true and useful statement about what the numbers cover.
  const where = opts.storeName ?? 'All stores';
  return `${when} · ${where}`;
}

/** "14 Aug 2026, 16:32" — a date a human reads, with the time that makes it exact. */
function formatInstant(at: Date): string {
  const date = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date}, ${time}`;
}

/**
 * The file's name, which is the other half of the same job: a folder of
 * `report.csv`, `report (1).csv`, `report (2).csv` is a folder of files nobody
 * can tell apart.
 *
 * Lower-cased, spaces and punctuation flattened to single dashes, so it is safe
 * on every platform the app shares to and still readable in a file list.
 */
export function exportFileName(prefix: string, scope: string): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const tail = slug(scope);
  return tail ? `${slug(prefix)}-${tail}` : slug(prefix);
}
