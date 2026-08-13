import { File } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { POSTER_SHAPES, type PosterShape } from '@/components/marketing/poster-canvas';

// react-native-view-shot DOES ship a web implementation (v5.1.0's
// lib/RNViewShot.web.js, backed by html2canvas) -- that part is not actually
// a platform gap. What web genuinely lacks is somewhere to put the result: no
// file system to save a captured PNG to, and expo-print's printToFileAsync
// opens the print dialog on web instead of returning a file (its own web
// module is literally `printToFileAsync() { window.print(); }` -- see
// node_modules/expo-print's ExponentPrint.web.ts). So SAVING or SHARING a
// poster *file* is something only a phone can do, and this constant gates
// exactly that. The screen reads it and offers Print alone in a browser --
// printPoster below, which captures the poster the same way this file
// already does for Save/Share, then hands the result straight to a print
// dialog instead of a file -- rather than a Save/Share button that quietly
// does nothing.
export const POSTER_EXPORT_SUPPORTED = Platform.OS !== 'web';

// A4 at 72 PPI, which is the unit printToFileAsync works in.
const A4_POINTS = { width: 595, height: 842 };

// No width/height here on purpose -- the SIZE IS DECIDED BY LAYOUT, not by the
// capture.
//
// The caller renders an off-screen copy of the poster at
// `exportWidthPx / PixelRatio.get()` points, which the platform then lays out
// at exactly `exportWidthPx` physical pixels. Capturing at its natural size is
// therefore already the target on both platforms, and asking for a resize on
// top of that is where this goes wrong -- because the two platforms disagree
// about what the numbers mean:
//
//   Android  ViewShot.java's `Bitmap.createScaledBitmap(bitmap, width, height)`
//            takes them as the literal OUTPUT PIXEL count.
//   iOS      RNViewShot.mm sizes a UIGraphicsImageRenderer in POINTS with
//            `format.scale = 0`, so they are multiplied by the device scale.
//
// So a value of `targetWidthPx / density` is right on iOS and scales an
// already-correct bitmap back DOWN by the density on Android: a "1080px"
// square arriving as 360px on a 3x phone, and a 1240px A4 sheet as 413px --
// soft in a feed and useless printed on a door. Letting layout do the sizing
// sidesteps the disagreement entirely.
export async function capturePosterPng(ref: React.RefObject<unknown>): Promise<string> {
  return captureRef(ref as never, {
    result: 'tmpfile',
    format: 'png',
    quality: 1,
    // iOS only. Without this, RNViewShot.mm's default strategy is
    // `drawViewHierarchyInRect:afterScreenUpdates:YES` -- a render-server
    // screenshot whose own inline comment admits "this doesn't work for
    // large views and reports incorrect success even though the image is
    // blank". That is exactly what this off-screen, far-outside-the-viewport
    // capture target is (see poster-sheet.tsx's `styles.offscreen`), so left
    // at the default it resolves with a blank PNG and no error. Passing this
    // switches iOS to `[layer renderInContext:]`, which walks the view's own
    // CALayer instead -- the same kind of layer-drawing pass Android already
    // takes by default (`View.draw(Canvas)` in ViewShot.java). Its documented
    // trade-offs (no gradients, no full-content ScrollView capture) cost
    // nothing here: the poster is flat colour, Text and one Image.
    useRenderInContext: true,
  });
}

// iOS's tmpfile result is a bare POSIX path from `RCTTempFilePath`
// (`NSTemporaryDirectory()/ReactNative/<uuid>.png`, no `file://` scheme) --
// fine for <Image source={{ uri }}>, which accepts either form, but
// expo-file-system's `File` validates the URL with `isFileURL` and rejects
// a schemeless one. Android's tmpfile result is already a proper `file://`
// URI (`Uri.fromFile(output).toString()` in ViewShot.java), so this is a
// no-op there.
function toFileUri(uri: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `file://${uri}`;
}

// Reads the just-captured PNG back off disk as a `data:image/png;base64,…`
// string, for posterPdfFromPngDataUri to embed directly in the PDF's HTML --
// see that function's header comment for why a file path cannot be used
// there instead. Reading the tmpfile back rather than capturing the poster a
// second time is what keeps the PNG a shop saves and the sheet it prints
// pixel-identical: two separate captures could drift apart if anything about
// the promotion or the picker changed between them.
export async function posterPngDataUri(pngUri: string): Promise<string> {
  const base64 = await new File(toFileUri(pngUri)).base64();
  return `data:image/png;base64,${base64}`;
}

// The PDF is the captured image on a page, not a second rendering of the
// poster. One renderer means the sheet on the door and the square in the feed
// cannot drift apart -- and expo-print cannot lay out a React tree anyway.
//
// Takes a data URI, not a file path, because expo-print's WebView cannot
// resolve a file path either way it's loaded:
//   Android  PrintPDFRenderTask.kt calls `webView.loadDataWithBaseURL(null,
//            html, …)`. A null base URL gives the page an opaque origin, and
//            `allowFileAccess` defaults to false on API 30+, so a
//            `file:///data/user/0/<pkg>/cache/…png` <img> src is blocked.
//   iOS      loads with `baseURL: Bundle.main.resourceURL`, so a captured
//            file's path (see `toFileUri`'s header comment on its schemeless
//            form) resolves against the APP BUNDLE, not the cache directory
//            the poster was actually written to.
// Inlining the bytes sidesteps both: there is no second origin to resolve
// against because there is no second location being referenced.
// Shared by the PDF path (posterPdfFromPngDataUri) and the Print path
// (printPoster) below -- one poster-in-a-page markup, not two, so a printed
// sheet and a saved one can never drift in size or margins. Margin-free and
// edge-to-edge: a poster is the whole page. The @page rule is what Android's
// WebView (and a browser's print dialog) honours; iOS takes the margins
// option separately, which both native callers below set to match.
function posterPageHtml(pngDataUri: string, shape: PosterShape): { html: string; page: { width: number; height: number } } {
  const ratio = POSTER_SHAPES[shape].ratio;
  const page = shape === 'sheet'
    ? A4_POINTS
    : { width: A4_POINTS.width, height: Math.round(A4_POINTS.width / ratio) };

  const html = `<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
  <style>
    @page { size: ${page.width}pt ${page.height}pt; margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { display: block; width: 100%; height: 100%; object-fit: contain; }
  </style>
  <body><img src="${pngDataUri}" /></body>
</html>`;

  return { html, page };
}

export async function posterPdfFromPngDataUri(pngDataUri: string, shape: PosterShape): Promise<string> {
  const { html, page } = posterPageHtml(pngDataUri, shape);
  const { uri } = await Print.printToFileAsync({
    html,
    width: page.width,
    height: page.height,
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  return uri;
}

// A hidden same-page <iframe>, not window.open(): some browsers (notably
// mobile ones, and any with popups blocked) silently reuse the *current* tab
// for a blocked popup instead of opening a new one, which would turn
// `document.write(html)` into overwriting this entire app's DOM with the
// poster page. An iframe never leaves the current page, so there's nothing to
// navigate to or "close" that could affect the app underneath -- the exact
// pattern receipt-modal.tsx's printHtml and export-file.ts's printHtmlOnWeb
// already use for the identical reason.
function printHtmlOnWeb(html: string) {
  // @ts-ignore -- web-only DOM APIs, only ever called on Platform.OS === 'web'.
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

// The web half of "Web offers Print". Deliberately NOT `Print.printAsync` on
// web -- expo-print's own web module ignores the `html` option entirely and
// just calls `window.print()` on whatever page happens to be on screen (see
// node_modules/expo-print's ExponentPrint.web.ts), which would print this
// app's chrome instead of the poster. `printHtmlOnWeb` above is what actually
// prints the poster's own page. On iOS/Android, `html` genuinely is honoured,
// so this reaches for the real thing there.
export async function printPoster(pngDataUri: string, shape: PosterShape): Promise<void> {
  const { html, page } = posterPageHtml(pngDataUri, shape);
  if (Platform.OS === 'web') {
    printHtmlOnWeb(html);
    return;
  }
  await Print.printAsync({ html, width: page.width, height: page.height });
}

export async function sharePoster(uri: string, mimeType: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(uri, { mimeType, UTI: mimeType === 'application/pdf' ? '.pdf' : '.png' });
}
