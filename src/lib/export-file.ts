import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform, Share } from 'react-native';

// expo-file-system's File/Directory classes are stubs on web (see
// src/lib/storage.ts), so web export goes through a Blob + a temporary
// `<a download>` click instead — the same DOM-manipulation approach already
// used by receipt-modal.tsx's openExternalUrl for the same "browsers may
// reuse/block a new tab" reason.
function downloadBlobOnWeb(blob: Blob, filename: string) {
  // @ts-ignore — web-only DOM APIs, only ever called on Platform.OS === 'web'.
  const url = URL.createObjectURL(blob);
  // @ts-ignore
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // @ts-ignore
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Mirrors receipt-modal.tsx's printHtml: a hidden same-page iframe rather
// than window.open(), since a blocked/reused popup there would navigate the
// whole app away instead of just failing to open a new tab.
function printHtmlOnWeb(html: string) {
  // @ts-ignore
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  // @ts-ignore
  document.body.appendChild(iframe);
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    iframe.remove();
    return;
  }
  frameWindow.document.open();
  frameWindow.document.write(html);
  frameWindow.document.close();
  frameWindow.focus();
  frameWindow.print();
  setTimeout(() => iframe.remove(), 1000);
}

export async function shareCsv(content: string, filename: string, dialogTitle: string): Promise<void> {
  if (Platform.OS === 'web') {
    downloadBlobOnWeb(new Blob([content], { type: 'text/csv;charset=utf-8;' }), filename);
    return;
  }
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(content);
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    Share.share({ message: content }).catch(() => {});
    return;
  }
  await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle });
}

// Native only produces a real, shareable PDF file — on web, expo-print's
// printToFileAsync opens the browser print dialog instead of returning a
// file (same constraint as src/lib/receipt-pdf.ts), so "export" there means
// "print / Save as PDF", matching the existing receipt Print button.
export async function sharePdf(html: string, dialogTitle: string): Promise<void> {
  if (Platform.OS === 'web') {
    printHtmlOnWeb(html);
    return;
  }
  const { uri } = await Print.printToFileAsync({ html });
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('sharing unavailable');
  await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle });
}
