import * as Print from 'expo-print';

import { buildReceiptHtml, type ReceiptData } from '@/lib/receipt';

// Renders the receipt to a real PDF file in the cache directory. Native
// only — expo-print's printToFileAsync opens the browser print dialog on
// web instead of returning a file, so callers must not invoke this when
// Platform.OS === 'web'.
export async function generateReceiptPdf(receipt: ReceiptData): Promise<string> {
  const { uri } = await Print.printToFileAsync({ html: buildReceiptHtml(receipt) });
  return uri;
}
