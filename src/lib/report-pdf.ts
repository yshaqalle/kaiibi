import type { CsvColumn } from '@/lib/csv';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Shared page chrome (fonts/colors/table styling) for every generated report
// PDF, so Inventory/Sales/Customers exports and the Dashboard report all
// look like one family rather than each screen inventing its own HTML.
function reportShell(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; background: #FFFFFF; margin: 0; padding: 28px 24px; color: #111111; }
  h1 { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; margin: 0 0 2px; }
  .subtitle { color: #777777; font-size: 12px; margin: 0 0 20px; }
  h2 { font-size: 13px; font-weight: 800; letter-spacing: 0.3px; text-transform: uppercase; color: #555555; margin: 22px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  th, td { text-align: left; padding: 7px 8px; font-size: 12px; border-bottom: 1px solid #EDEDED; }
  th { color: #999999; font-weight: 700; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
  td { color: #222222; }
  tr:last-child td { border-bottom: none; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 4px; }
  .stat { background: #F7F7F5; border-radius: 10px; padding: 12px 16px; min-width: 120px; }
  .stat .label { font-size: 10px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase; color: #999999; margin-bottom: 4px; }
  .stat .value { font-size: 17px; font-weight: 800; }
  .empty { color: #999999; font-size: 12px; font-style: italic; padding: 6px 0; }
  @media print { body { padding: 0 8px; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function tableHtml<T>(columns: CsvColumn<T>[], rows: T[]): string {
  if (rows.length === 0) return '<div class="empty">No data for this range.</div>';
  const head = columns.map((c) => `<th>${esc(c.header)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${esc(c.value(row))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// A single Inventory/Sales/Customers list export — one table under a title.
export function buildTableReportHtml<T>(opts: { title: string; subtitle?: string; columns: CsvColumn<T>[]; rows: T[] }): string {
  const body = `<h1>${esc(opts.title)}</h1>${opts.subtitle ? `<p class="subtitle">${esc(opts.subtitle)}</p>` : ''}${tableHtml(opts.columns, opts.rows)}`;
  return reportShell(opts.title, body);
}

export type ReportStat = { label: string; value: string };
export type ReportSection = { title: string; columns: CsvColumn<any>[]; rows: any[] };

// The Dashboard's "Export PDF" — a tabular summary of whatever the screen
// currently has loaded (stat totals plus each breakdown table), not a
// screenshot of the charts themselves.
export function buildDashboardReportHtml(opts: { title: string; subtitle: string; stats: ReportStat[]; sections: ReportSection[] }): string {
  const statsHtml = opts.stats.length
    ? `<div class="stats">${opts.stats.map((s) => `<div class="stat"><div class="label">${esc(s.label)}</div><div class="value">${esc(s.value)}</div></div>`).join('')}</div>`
    : '';
  const sectionsHtml = opts.sections
    .map((section) => `<h2>${esc(section.title)}</h2>${tableHtml(section.columns, section.rows)}`)
    .join('');
  const body = `<h1>${esc(opts.title)}</h1><p class="subtitle">${esc(opts.subtitle)}</p>${statsHtml}${sectionsHtml}`;
  return reportShell(opts.title, body);
}
