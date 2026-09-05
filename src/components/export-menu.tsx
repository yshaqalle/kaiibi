import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors } from '@/constants/theme';
import type { CsvColumn } from '@/lib/csv';
import { rowsToCsv } from '@/lib/csv';
import { shareCsv, sharePdf } from '@/lib/export-file';
import { buildDashboardReportHtml, buildTableReportHtml, type ReportSection } from '@/lib/report-pdf';

// Exports whatever `rows` the caller currently has on screen -- each of
// Inventory/Sales/Customers passes its own already-filtered/searched/sorted
// list, so the export always matches what's visible, not the full table.
export function ExportMenu<T>({ rows, columns, title, subtitle, filenamePrefix, variant = 'default', pdfSections }: {
  rows: T[];
  columns: CsvColumn<T>[];
  title: string;
  subtitle?: string;
  filenamePrefix: string;
  /**
   * `bento` for a converted screen -- Accounting and the reports. It is the
   * control-bar chip rather than the cream block, because on those screens this
   * sits in the header row directly beside the range and store pills, and two
   * button shapes in one row read as two unrelated controls.
   *
   * Quiet rather than filled, on the rule the hub cards follow: a solid fill
   * means the press WRITES. An export produces a file and changes nothing in
   * the shop, so it takes the same weight as the picker next to it.
   *
   * The default is untouched on purpose. Inventory, People and Schedule still
   * wear the cream palette, and repointing this would restyle them mid-flight.
   */
  variant?: 'default' | 'bento';
  /**
   * Extra tables for the PDF only, for a report that shows more than one.
   *
   * The two formats genuinely cannot carry the same thing: a PDF holds
   * sections, a CSV file is one grid. Rather than adding a picker for the two
   * screens affected, the CSV takes the report's PRIMARY grid -- the `rows` and
   * `columns` above -- and the PDF takes everything. The filename says which,
   * which is the honest way to answer the question without a control most
   * people would meet once.
   */
  pdfSections?: ReportSection[];
}) {
  const bento = variant === 'bento';
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null);

  const exportCsv = async () => {
    setBusy('csv');
    try {
      await shareCsv(rowsToCsv(rows, columns), `${filenamePrefix}.csv`, title);
    } catch {
      // Sharing can be cancelled by the user -- nothing to surface.
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = async () => {
    setBusy('pdf');
    try {
      const html = pdfSections?.length
        ? buildDashboardReportHtml({ title, subtitle: subtitle ?? '', stats: [], sections: pdfSections })
        : buildTableReportHtml({ title, subtitle, columns, rows });
      await sharePdf(html, title);
    } catch {
      // Sharing can be cancelled by the user -- nothing to surface.
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.row}>
      <Pressable onPress={exportCsv} disabled={busy !== null} style={[styles.button, bento && styles.buttonBento]}>
        {busy === 'csv' ? (
          <ActivityIndicator size="small" color={bento ? theme.bentoInk2 : '#FFFFFF'} />
        ) : (
          <Text style={[styles.buttonText, bento && styles.buttonTextBento]}>Export CSV</Text>
        )}
      </Pressable>
      <Pressable onPress={exportPdf} disabled={busy !== null} style={[styles.button, bento && styles.buttonBento]}>
        {busy === 'pdf' ? (
          <ActivityIndicator size="small" color={bento ? theme.bentoInk2 : '#FFFFFF'} />
        ) : (
          <Text style={[styles.buttonText, bento && styles.buttonTextBento]}>Export PDF</Text>
        )}
      </Pressable>
    </View>
  );
}

const theme = Colors.light;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
  // The same chip the range and store pills wear -- see category-chip.tsx and
  // the close pill in checkout-panel.tsx, which is the shipped vocabulary.
  buttonBento: {
    backgroundColor: theme.bentoSurface,
    borderWidth: 1,
    borderColor: theme.bentoLine,
    borderRadius: 999,
    paddingHorizontal: 15,
    paddingVertical: 8,
  },
  buttonTextBento: { color: theme.bentoInk2, fontWeight: '700', fontSize: 12.5 },
});
