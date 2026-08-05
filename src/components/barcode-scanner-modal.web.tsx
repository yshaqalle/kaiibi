import { BarcodeDetector } from 'barcode-detector/ponyfill';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BarcodeScannerFrame, type BarcodeScannerModalProps, type CameraStatus } from '@/components/barcode-scanner-frame';
import { acceptScan, initialScanGate, normalizeBarcode, shouldAcceptScan, WEB_BARCODE_FORMATS } from '@/lib/barcode';

// The browser scanner.
//
// This file exists because expo-camera's web build only recognises QR codes --
// its `onBarcodeScanned` is documented for Android and iOS only. Every code
// actually printed on retail stock (EAN-13, UPC-A, Code 128) would simply never
// fire the callback, so the browser needs its own decoder.
//
// The browser's own `BarcodeDetector` API isn't enough either: it is
// Chromium-only, which means EVERY browser on iOS lacks it (they are all
// WebKit), as do Firefox everywhere and desktop Safari. Relying on it alone
// would mean "scanning works on an Android phone and nowhere else". The
// `barcode-detector` ponyfill presents that same interface, backed by the
// native implementation where it exists and a ZXing WASM build where it
// doesn't -- so one code path covers the whole fleet.

// ~10 frames a second. The WASM decode is the expensive part and a person
// aiming a phone at a label cannot benefit from more; running it every frame
// just heats the device and slows the preview it is reading from.
const DETECT_INTERVAL_MS = 100;

export function BarcodeScannerModal({
  visible,
  onClose,
  onScan,
  mode = 'single',
  title = 'Scan a barcode',
  hint,
  feedback = null,
}: BarcodeScannerModalProps) {
  const [status, setStatus] = useState<CameraStatus>('checking');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  // Derived from the caller's result, not stored: same reasoning as the native
  // modal -- one owner of how long a result stands.
  const flash = feedback ? (feedback.tone === 'ok' ? 'ok' : 'error') : null;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const gateRef = useRef(initialScanGate());
  const inFlightRef = useRef(false);
  // Set on teardown so a detect loop already in flight stops instead of
  // decoding against a video whose tracks have been stopped.
  const cancelledRef = useRef(false);

  const handleCode = useCallback(async (raw: string) => {
    const code = normalizeBarcode(raw);
    if (!code) return;
    if (inFlightRef.current) return;
    if (!shouldAcceptScan(gateRef.current, code, Date.now())) return;

    gateRef.current = acceptScan(gateRef.current, code, Date.now(), mode);
    inFlightRef.current = true;
    try {
      await onScan(code);
    } finally {
      inFlightRef.current = false;
    }
    if (mode === 'single') onClose();
  }, [mode, onScan, onClose]);

  useEffect(() => {
    if (!visible) return;

    cancelledRef.current = false;
    gateRef.current = initialScanGate();
    let detectTimer: ReturnType<typeof setTimeout> | null = null;

    const start = async () => {
      // Not just politeness: on a page served over plain HTTP (a LAN dev URL
      // like http://192.168.1.5:8081) `mediaDevices` is undefined entirely,
      // and without this check that reads as a mysterious crash rather than
      // the browser's security rule that it is.
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        setStatusDetail(
          typeof window !== 'undefined' && !window.isSecureContext
            ? 'Cameras need a secure (https) connection. Open the app over https and try again.'
            : 'This browser cannot open a camera.'
        );
        return;
      }

      let stream: MediaStream;
      try {
        // `ideal`, not `exact`: a laptop has only a front camera, and demanding
        // the rear one there fails outright instead of using what exists.
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('blocked');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
          setStatus('unavailable');
        } else {
          setStatus('unavailable');
          setStatusDetail((err as { message?: string } | null)?.message ?? null);
        }
        return;
      }

      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      setStatus('ready');

      // Imported statically, not with `await import()`. The lazy version is
      // what you'd want -- the decoder is only needed by someone who actually
      // scans -- but Metro's async chunks don't resolve a package-exports
      // subpath at runtime: it bundles fine and then throws "Requiring unknown
      // module" the first time the scanner opens. A static import is the
      // working trade, and it costs the web bundle only the JS glue; the
      // several-hundred-KB .wasm itself is still fetched on first use.
      let detector: BarcodeDetector;
      try {
        detector = new BarcodeDetector({ formats: [...WEB_BARCODE_FORMATS] });
      } catch {
        setStatus('unavailable');
        setStatusDetail('The barcode decoder could not start in this browser. You can still type or scan a code below.');
        return;
      }

      // A single failed decode means nothing -- motion blur, bad angle, half a
      // label in frame. A long unbroken run of them means the decoder itself
      // never came up, which on the web usually means its WASM binary could not
      // be fetched (offline, or a network that blocks the CDN). Those look
      // identical frame by frame and completely different in a row, so the
      // difference is worth counting: otherwise the shop gets a live camera
      // that silently never scans, which is the exact failure the permission
      // screens were written to avoid.
      let consecutiveFailures = 0;

      const tick = async () => {
        if (cancelledRef.current) return;
        const video = videoRef.current;
        // `readyState` guards the window between the element mounting and the
        // first frame arriving, when decoding throws.
        if (video && video.readyState >= 2 && !gateRef.current.locked && !inFlightRef.current) {
          try {
            const results = await detector.detect(video);
            consecutiveFailures = 0;
            if (results.length > 0) await handleCode(results[0].rawValue);
          } catch {
            consecutiveFailures += 1;
            // ~2 seconds of nothing but errors.
            if (consecutiveFailures >= 20) {
              setStatus('unavailable');
              setStatusDetail('The barcode decoder could not load. Check the connection, or type the code below.');
              return;
            }
          }
        }
        if (!cancelledRef.current) detectTimer = setTimeout(tick, DETECT_INTERVAL_MS);
      };
      tick();
    };

    start();

    return () => {
      cancelledRef.current = true;
      if (detectTimer) clearTimeout(detectTimer);
      // Without this the camera indicator light stays on after the modal
      // closes, and the next open can fail because the device is still held.
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus('checking');
      setStatusDetail(null);
    };
  }, [visible, handleCode]);

  if (!visible) return null;

  return (
    <BarcodeScannerFrame
      onClose={onClose}
      title={title}
      hint={hint}
      feedback={feedback}
      status={status}
      statusDetail={statusDetail}
      flash={flash}
      // No torch on the web: MediaStreamTrack torch constraints are
      // Chromium-on-Android only, so the control would be absent far more often
      // than present.
      torch={null}
      onManualSubmit={handleCode}
    >
      <video
        ref={(node) => {
          videoRef.current = node;
          if (node && streamRef.current && node.srcObject !== streamRef.current) {
            node.srcObject = streamRef.current;
          }
        }}
        autoPlay
        muted
        // Load-bearing on iOS Safari: without it the video takes over the
        // screen in the native fullscreen player and the overlay disappears.
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </BarcodeScannerFrame>
  );
}
