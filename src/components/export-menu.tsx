import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { CsvColumn } from '@/lib/csv';
import { rowsToCsv } from '@/lib/csv';
import { shareCsv, sharePdf } from '@/lib/export-file';
import { buildTableReportHtml } from '@/lib/report-pdf';

// Exports whatever `rows` the caller currently has on screen -- each of
// Inventory/Sales/Customers passes its own already-filtered/searched/sorted
// list, so the export always matches what's visible, not the full table.
export function ExportMenu<T>({ rows, columns, title, subtitle, filenamePrefix }: {
  rows: T[];
  columns: CsvColumn<T>[];
  title: string;
  subtitle?: string;
  filenamePrefix: string;
}) {
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
      await sharePdf(buildTableReportHtml({ title, subtitle, columns, rows }), title);
    } catch {
      // Sharing can be cancelled by the user -- nothing to surface.
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.row}>
      <Pressable onPress={exportCsv} disabled={busy !== null} style={styles.button}>
        {busy === 'csv' ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.buttonText}>Export CSV</Text>}
      </Pressable>
      <Pressable onPress={exportPdf} disabled={busy !== null} style={styles.button}>
        {busy === 'pdf' ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Text style={styles.buttonText}>Export PDF</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: { backgroundColor: '#111111', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 11 },
});
