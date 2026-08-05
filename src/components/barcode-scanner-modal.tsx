import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';

import { BarcodeScannerFrame, type BarcodeScannerModalProps, type CameraStatus } from '@/components/barcode-scanner-frame';
import { acceptScan, initialScanGate, normalizeBarcode, RETAIL_BARCODE_TYPES, shouldAcceptScan } from '@/lib/barcode';

export type { BarcodeScannerModalProps };

export function BarcodeScannerModal({
  visible,
  onClose,
  onScan,
  mode = 'single',
  title = 'Scan a barcode',
  hint,
  feedback = null,
  barcodeTypes = RETAIL_BARCODE_TYPES,
}: BarcodeScannerModalProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  // Mirrors `gateRef.current.locked`. The ref is what the scan path reads (it
  // must not wait for a render); this is what the render reads, because
  // touching a ref during render is exactly the kind of tearing React 19 warns
  // about.
  const [locked, setLocked] = useState(false);
  // The preview failed to start even though permission was granted. Permission
  // alone is not proof of a working camera: a simulator has none at all, and a
  // real device can have one held by another app or failing outright. Without
  // this the modal shows a black rectangle with a reticle over it and no
  // explanation -- the same silent dead end the permission screens exist to
  // avoid, just arrived at from the other direction.
  const [mountFailed, setMountFailed] = useState(false);

  // Refs, not state: `onBarcodeScanned` fires on every frame that contains a
  // code, and re-rendering the camera 30 times a second to record that would
  // stutter the preview it is reading from.
  const gateRef = useRef(initialScanGate());
  const inFlightRef = useRef(false);

  // The tone of the caller's feedback IS the flash -- derived, not stored, so
  // the wash and the message can never disagree and no second timer has to
  // agree with the caller's.
  const flash = feedback ? (feedback.tone === 'ok' ? 'ok' : 'error') : null;

  // Haptics, unlike the flash, are an event rather than a state: they fire once
  // per result and there is nothing to render.
  useEffect(() => {
    if (!feedback || Platform.OS === 'web') return;
    Haptics.notificationAsync(
      feedback.tone === 'ok' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error
    ).catch(() => {});
  }, [feedback]);

  // Reset here rather than in an effect watching `visible`: closing is an event,
  // and doing it on the event keeps the next open clean without a render pass
  // whose only job is to undo the last one.
  const close = () => {
    gateRef.current = initialScanGate();
    inFlightRef.current = false;
    setLocked(false);
    setTorch(false);
    setMountFailed(false);
    onClose();
  };

  if (!visible) return null;

  const handleCode = async (raw: string) => {
    const code = normalizeBarcode(raw);
    if (!code) return;
    if (inFlightRef.current) return;
    if (!shouldAcceptScan(gateRef.current, code, Date.now())) return;

    gateRef.current = acceptScan(gateRef.current, code, Date.now(), mode);
    if (gateRef.current.locked) setLocked(true);
    inFlightRef.current = true;
    try {
      await onScan(code);
    } finally {
      inFlightRef.current = false;
    }
    // In single mode the gate is already latched, so the frames still arriving
    // during the close animation cannot produce a second scan.
    if (mode === 'single') close();
  };

  // A simulator has no camera, and asking it for one produces a permanently
  // black preview rather than an error anyone can act on: the capture session
  // fails at RUNTIME (AVFoundation -11800), which is not the same thing as
  // failing to mount, so `onMountError` never fires and nothing tells the UI.
  // `Device.isDevice` answers it exactly instead of inferring it from a
  // timeout, and keeps the modal honest about why it can't scan.
  const noCameraHardware = !Device.isDevice;

  const status: CameraStatus =
    noCameraHardware || mountFailed
      ? 'unavailable'
      : !permission
        ? 'checking'
        : permission.granted
          ? 'ready'
          : permission.canAskAgain
            ? 'prompt'
            : 'blocked';

  return (
    <BarcodeScannerFrame
      onClose={close}
      title={title}
      hint={hint}
      feedback={feedback}
      status={status}
      statusDetail={
        noCameraHardware
          ? 'Simulators have no camera. Type a code below, or try scanning on a real device.'
          : mountFailed
            ? 'The camera could not start. It may be in use by another app.'
            : null
      }
      onRequestPermission={() => { requestPermission().catch(() => {}); }}
      flash={flash}
      // Torch is a native capability; the web build has no equivalent control.
      torch={Platform.OS === 'web' ? null : { on: torch, onToggle: () => setTorch((on) => !on) }}
      onManualSubmit={handleCode}
    >
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        onMountError={() => setMountFailed(true)}
        barcodeScannerSettings={{ barcodeTypes: barcodeTypes as BarcodeType[] }}
        // Detaching the handler is the only reliable way to stop the native
        // callback; leaving it attached and returning early still pays the
        // decode cost on every frame.
        onBarcodeScanned={locked ? undefined : (result) => { handleCode(result.data); }}
      />
    </BarcodeScannerFrame>
  );
}
