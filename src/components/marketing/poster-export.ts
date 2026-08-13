import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { PixelRatio, Platform } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { POSTER_SHAPES, type PosterShape } from '@/components/marketing/poster-canvas';

// react-native-view-shot is Android and iOS only, and expo-print's
// printToFileAsync on web opens the print dialog rather than returning a file.
// So saving a poster is something the app does on a phone. The screen reads
// this and offers Print alone in a browser, rather than a Save button that
// quietly does nothing -- which is the failure this constant exists to prevent.
export const POSTER_EXPORT_SUPPORTED = Platform.OS !== 'web';

// A4 at 72 PPI, which is the unit printToFileAsync works in.
const A4_POINTS = { width: 595, height: 842 };

// captureRef sizes in LOGICAL pixels, so a target of 1080 physical pixels on a
// 3x device is 360 logical. Skipping this is how an export comes out three
// times the intended size (and several megabytes) on one phone and correct on
// another.
export async function capturePosterPng(
  ref: React.RefObject<unknown>,
  shape: PosterShape,
  targetWidthPx: number
): Promise<string> {
  const density = PixelRatio.get();
  // Height follows the shape, not the width. A square target on a 9:16 story
  // would capture a squashed poster -- and it would look fine in the preview,
  // because only the export is wrong.
  const targetHeightPx = Math.round(targetWidthPx / POSTER_SHAPES[shape].ratio);
  return captureRef(ref as never, {
    result: 'tmpfile',
    format: 'png',
    quality: 1,
    width: targetWidthPx / density,
    height: targetHeightPx / density,
  });
}

// The PDF is the captured image on a page, not a second rendering of the
// poster. One renderer means the sheet on the door and the square in the feed
// cannot drift apart -- and expo-print cannot lay out a React tree anyway.
export async function posterPdfFromPng(pngUri: string, shape: PosterShape): Promise<string> {
  const ratio = POSTER_SHAPES[shape].ratio;
  const page = shape === 'sheet'
    ? A4_POINTS
    : { width: A4_POINTS.width, height: Math.round(A4_POINTS.width / ratio) };

  // Margin-free and edge-to-edge: a poster is the whole page. The @page rule is
  // what Android's WebView honours; iOS takes the margins option, and both are
  // set so neither platform adds a white border of its own.
  const html = `<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
  <style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { display: block; width: 100%; height: 100%; object-fit: contain; }
  </style>
  <body><img src="${pngUri}" /></body>
</html>`;

  const { uri } = await Print.printToFileAsync({
    html,
    width: page.width,
    height: page.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  return uri;
}

export async function sharePoster(uri: string, mimeType: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) return;
  await Sharing.shareAsync(uri, { mimeType, UTI: mimeType === 'application/pdf' ? '.pdf' : '.png' });
}
