import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { POSTER_SHAPES, type PosterShape } from '@/components/marketing/poster-canvas';
import { singleImagePdf } from '@/lib/pdf-image';

// react-native-view-shot DOES ship a web implementation (v5.1.0's
// lib/RNViewShot.web.js, backed by html2canvas) -- that part is not actually
// a platform gap. What web genuinely lacks is a FILE SYSTEM: nowhere to put
// a `result: 'tmpfile'` capture (see capturePosterPng below), and
// expo-print's printToFileAsync opens the print dialog on web instead of
// returning a file (its own web module is literally
// `printToFileAsync() { window.print(); }` -- see node_modules/expo-print's
// ExponentPrint.web.ts). So a real FILE -- and anything that only a file can
// do, `Sharing.shareAsync` chief among them -- is phone-only, and this
// constant gates exactly that: the screen reads it to decide between the
// phone's Share/PDF-file buttons and web's own file-less paths (Download
// image/PDF, both built on the direct-to-data-URI capture below, and Print).
export const POSTER_EXPORT_SUPPORTED = Platform.OS !== 'web';

// A4 at 72 PPI, which is the unit printToFileAsync works in.
const A4_POINTS = { width: 595, height: 842 };

// A capture that never settles must not leave a Pressable reading
// "Printing…" / "Downloading…" forever with no way out but a reload.
// html2canvas -- the backend behind react-native-view-shot's web
// implementation, which every function below eventually calls into on web
// -- is known to hang rather than reject on certain images (notably a
// cross-origin one it cannot proxy), so `busy`'s own `finally` in
// poster-sheet.tsx, which only runs once the awaited promise SETTLES one way
// or the other, cannot be trusted alone to end that. 20s is generous for a
// poster-sized capture (at most a few hundred KB) while still being far
// short of "the owner gave up and reloaded the page".
const CAPTURE_TIMEOUT_MS = 20000;
function withCaptureTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The poster capture timed out.')), CAPTURE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

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
  return withCaptureTimeout(
    captureRef(ref as never, {
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
    })
  );
}

// The direct-to-data-URI capture -- no tmpfile, no filesystem read-back.
// `result: 'data-uri'` is a first-class option on every platform this app
// ships to (see ios/RNViewShot.mm's `data-uri` branch and Android's
// ViewShot.java `DATA_URI` case), producing `data:image/png;base64,…`
// straight from the capture -- and, on web, from html2canvas's own
// `canvas.toDataURL()` (RNViewShot.web.js), which needs no filesystem at
// all. That is the actual story of the web Print bug this replaced: the old
// code asked for `result: 'tmpfile'` (capturePosterPng, above) -- a location
// web genuinely does not have -- for a value this option produces directly,
// no filesystem involved on any platform. Used for Print (web's only export
// target that ever needs a data URI rather than a file) and for the "Download
// image" button below; native's Share/PDF-to-file paths still want a real
// file and keep using capturePosterPng for that.
export async function posterPngDataUri(ref: React.RefObject<unknown>): Promise<string> {
  return withCaptureTimeout(
    captureRef(ref as never, {
      result: 'data-uri',
      format: 'png',
      quality: 1,
      useRenderInContext: true,
    })
  );
}

// Only ever called from downloadPosterPdf below. `atob` is a browser global
// with no Hermes/RN equivalent, but that's fine the same way `document` is
// fine in `printHtmlOnWeb` further down -- neither is referenced unless the
// surrounding function actually runs, and both only ever run on web.
function base64ToBytes(base64: string): Uint8Array {
  // @ts-ignore -- web-only global.
  const binary: string = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// JPEG rather than PNG for the web PDF path (downloadPosterPdf below): a
// JPEG's own compressed bytes embed directly into a PDF behind /DCTDecode
// (see pdf-image.ts), no compression work of this app's own needed, where a
// PNG would need Flate plus predictors this app has no library for. 0.92
// quality is high enough that a poster -- flat colour, text, at most one
// photo -- shows no visible banding, while still compressing meaningfully
// smaller than the PNG capture.
// The poster as raw PNG bytes, for the web download path. Same capture the
// rest of this file uses, unwrapped from its data URI so it can be handed to
// a Blob -- see downloadPosterPng for why a Blob rather than the URI itself.
async function posterPngBytes(ref: React.RefObject<unknown>): Promise<Uint8Array> {
  const dataUri = await withCaptureTimeout(
    captureRef(ref as never, {
      result: 'data-uri',
      format: 'png',
      quality: 1,
      useRenderInContext: true,
    })
  );
  return base64ToBytes(dataUri.slice(dataUri.indexOf(',') + 1));
}

async function posterJpegBytes(ref: React.RefObject<unknown>): Promise<Uint8Array> {
  const dataUri = await withCaptureTimeout(
    captureRef(ref as never, {
      result: 'data-uri',
      format: 'jpg',
      quality: 0.92,
      useRenderInContext: true,
    })
  );
  return base64ToBytes(dataUri.slice(dataUri.indexOf(',') + 1));
}

// Point size (72 PPI, matching printToFileAsync/@page's own unit) for
// whatever shape the poster is -- shared by posterPageHtml below and by
// downloadPosterPdf further down, so a sheet is always A4 and a
// square/story page is always exactly as tall as A4 is wide, on every path
// that produces one, not just the native print/PDF path.
function pageSizeForShape(shape: PosterShape): { width: number; height: number } {
  if (shape === 'sheet') return A4_POINTS;
  const ratio = POSTER_SHAPES[shape].ratio;
  return { width: A4_POINTS.width, height: Math.round(A4_POINTS.width / ratio) };
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
//            file's own tmpfile path would resolve against the APP BUNDLE,
//            not the cache directory the poster was actually written to.
// Inlining the bytes sidesteps both: there is no second origin to resolve
// against because there is no second location being referenced.
// Shared by the PDF path (posterPdfFromPngDataUri) and the Print path
// (printPoster) below -- one poster-in-a-page markup, not two, so a printed
// sheet and a saved one can never drift in size or margins. Margin-free and
// edge-to-edge: a poster is the whole page. The @page rule is what Android's
// WebView (and a browser's print dialog) honours; iOS takes the margins
// option separately, which both native callers below set to match.
function posterPageHtml(pngDataUri: string, shape: PosterShape): { html: string; page: { width: number; height: number } } {
  const page = pageSizeForShape(shape);

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

// The same technique external-url.ts uses to open a link on web, and for the
// same reason: a plain navigation, or `window.open`, can be silently
// redirected to the CURRENT tab by a popup blocker (mobile browsers
// especially), which for a download would either do nothing or replace this
// whole app with the raw data. A real `<a download>` element's click is
// honoured by the browser as "save this", never as "go here", so there is
// nothing for a blocker to reroute.
function clickDownload(href: string, fileName: string): void {
  // @ts-ignore -- web-only DOM APIs, only ever called on Platform.OS === 'web'.
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  // @ts-ignore
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Web's "Download image" button.
//
// A Blob, not the `data:` URI the capture already hands us, even though that
// URI is a perfectly good `href` in Chrome and Firefox. Safari is the reason:
// it caps what an `<a download>` will accept as a data URL and, past that
// ceiling, does nothing at all -- no download, no error, no console warning.
// The button simply sits on "Downloading…" forever, which is precisely how
// this surfaced. A 1080x1080 poster is comfortably large enough to trip it,
// and there is no size at which the data URI is *better*, so this path takes
// the same Blob route downloadPosterPdf already documents below.
export async function downloadPosterPng(ref: React.RefObject<unknown>, fileName: string): Promise<void> {
  const bytes = await posterPngBytes(ref);
  // @ts-ignore -- web-only DOM APIs, only ever called on Platform.OS === 'web'.
  const blob = new Blob([bytes], { type: 'image/png' });
  // @ts-ignore
  const url = URL.createObjectURL(blob);
  clickDownload(url, fileName);
  // A tick's delay before revoking, for the same reason the PDF path waits:
  // some browsers read the object URL asynchronously past the synchronous
  // .click(), and revoking first aborts a download that had barely begun.
  setTimeout(() => {
    // @ts-ignore
    URL.revokeObjectURL(url);
  }, 1000);
}

// Web's "Download PDF" button, and the one genuinely new capability this
// file adds: nothing upstream of this function has ever produced an actual
// PDF file on web before (Print only ever reached a browser's print dialog,
// never a saved file). Captures as JPEG (see posterJpegBytes above for why),
// hands the bytes to pdf-image.ts's pure `singleImagePdf` for the actual
// assembly, then downloads the result as a Blob rather than a `data:` URL --
// a PDF is easily several hundred KB to a few MB once the image is embedded,
// comfortably past the size some browsers cap a `data:` URI at, where a Blob
// object URL has no such ceiling.
export async function downloadPosterPdf(ref: React.RefObject<unknown>, shape: PosterShape, fileName: string): Promise<void> {
  const jpegBytes = await posterJpegBytes(ref);
  const page = pageSizeForShape(shape);
  const pdfBytes = singleImagePdf(jpegBytes, page.width, page.height);
  // @ts-ignore -- web-only DOM APIs, only ever called on Platform.OS === 'web'.
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  // @ts-ignore
  const url = URL.createObjectURL(blob);
  clickDownload(url, fileName);
  // A tick's delay before revoking, not immediate -- the same caution
  // `printHtmlOnWeb`'s iframe removal above takes: some browsers process a
  // download asynchronously past the synchronous `.click()`, and revoking
  // the object URL before that read has actually started would abort a
  // download that had barely begun.
  setTimeout(() => {
    // @ts-ignore
    URL.revokeObjectURL(url);
  }, 1000);
}
