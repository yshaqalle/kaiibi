import { useState } from 'react';
import { Linking, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ScanFeedbackBanner } from '@/components/scan-feedback-banner';
import { normalizeBarcode, type ScanFeedback } from '@/lib/barcode';

// Everything about the scanner except the detector itself.
//
// The native and web scanners differ in exactly one way -- expo-camera's web
// build only recognises QR codes, so the browser needs its own decoder -- and
// in no other. Keeping the chrome here means the permission wording, the
// manual-entry escape hatch, the success flash and the layout can't drift apart
// between the two, which is what a straight `.web.tsx` fork of the whole modal
// would have guaranteed.

// What the camera can do right now, from the point of view of someone holding
// an item up to it. Native derives this from `useCameraPermissions`, web from
// how `getUserMedia` rejected -- different APIs, identical consequences.
export type CameraStatus =
  | 'checking'
  | 'prompt' // not granted, but we may still ask
  | 'blocked' // refused for good; only the OS/browser settings can undo it
  | 'unavailable' // no camera on this device, or the browser can't reach one
  | 'ready';

// The contract both scanner implementations honour. It lives here, in the file
// they already share, rather than in the native modal -- the web build resolves
// `barcode-scanner-modal` to ITSELF, so importing the type from there is a
// self-reference that only works because types are erased.
export type BarcodeScannerModalProps = {
  visible: boolean;
  onClose: () => void;
  // Receives an already-normalized code. Awaited, so the scanner can hold off
  // further scans while the caller resolves this one.
  onScan: (code: string) => void | Promise<unknown>;
  // 'continuous' for a basket at the till; 'single' everywhere a scan answers
  // one question and the modal should get out of the way.
  mode?: 'single' | 'continuous';
  title?: string;
  hint?: string;
  // Owned by the caller: only it knows whether a code meant "added to the sale"
  // or "not carried at this store".
  feedback?: ScanFeedback | null;
  barcodeTypes?: readonly string[];
};

export function BarcodeScannerFrame({
  onClose,
  title,
  hint,
  feedback,
  status,
  statusDetail,
  onRequestPermission,
  flash,
  torch,
  onManualSubmit,
  children,
}: {
  onClose: () => void;
  title: string;
  hint?: string;
  feedback: ScanFeedback | null;
  status: CameraStatus;
  // The specific reason, when there is one worth showing (a getUserMedia error
  // the generic copy would flatten).
  statusDetail?: string | null;
  onRequestPermission?: () => void;
  flash: 'ok' | 'error' | null;
  torch?: { on: boolean; onToggle: () => void } | null;
  onManualSubmit: (code: string) => void;
  // The live camera surface. Only rendered when `status` is 'ready'.
  children?: React.ReactNode;
}) {
  const [manual, setManual] = useState('');

  const submitManual = () => {
    const code = normalizeBarcode(manual);
    if (!code) return;
    onManualSubmit(code);
    setManual('');
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        {/* `height`, not `maxHeight`: the camera surface below is flex-sized and
            needs a concrete parent to fill, or it resolves to zero height --
            the same Yoga pitfall documented in product-modal.tsx. */}
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <View style={styles.headerActions}>
              {torch && status === 'ready' && (
                <Pressable onPress={torch.onToggle} style={[styles.torch, torch.on && styles.torchOn]}>
                  <Text style={[styles.torchText, torch.on && styles.torchTextOn]}>Light</Text>
                </Pressable>
              )}
              <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.closePressed]}>
                <Text style={styles.closeText}>Done</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.viewport}>
            {status === 'ready' ? (
              <>
                {children}
                <ScanReticle />
                <FlashOverlay flash={flash} />
              </>
            ) : (
              <CameraUnavailable status={status} detail={statusDetail} onRequestPermission={onRequestPermission} />
            )}
          </View>

          <View style={styles.footer}>
            {feedback ? (
              <ScanFeedbackBanner feedback={feedback} />
            ) : (
              // Only while there is actually a camera. "Point the camera at a
              // barcode" printed underneath "No camera available on this
              // device" is a straight contradiction, and the reader has to
              // work out which half to believe.
              status === 'ready' && hint && <Text style={styles.hint}>{hint}</Text>
            )}
            {/* Always present, not just as a fallback. It is the way to enter a
                code the camera can't read (a torn or curved label), and on a
                desktop till it is where a USB scanner types. */}
            <View style={styles.manualRow}>
              <TextInput
                value={manual}
                onChangeText={setManual}
                onSubmitEditing={submitManual}
                placeholder="Or type / scan a code"
                placeholderTextColor="#999999"
                style={styles.manualInput}
                // Not `number-pad`: the SKU fallback means codes can be
                // alphanumeric.
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                blurOnSubmit={false}
                // Focused whenever there is no camera, so a scanner has
                // somewhere to type and the modal is never a dead end.
                autoFocus={status !== 'ready' && status !== 'checking'}
              />
              <Pressable onPress={submitManual} disabled={!manual.trim()} style={[styles.manualGo, !manual.trim() && styles.manualGoDisabled]}>
                <Text style={styles.manualGoText}>Find</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// An aiming aid only. expo-camera has no region-of-interest setting, so a code
// anywhere in frame is detected -- the corners exist to stop people holding the
// phone a metre away, not to constrain the scan.
function ScanReticle() {
  return (
    <View pointerEvents="none" style={styles.reticle}>
      <View style={[styles.corner, styles.cornerTL]} />
      <View style={[styles.corner, styles.cornerTR]} />
      <View style={[styles.corner, styles.cornerBL]} />
      <View style={[styles.corner, styles.cornerBR]} />
    </View>
  );
}

// A full-bleed colour wash over the preview for as long as there's a result to
// report.
//
// The cashier is looking at the item, not the screen, so this has to be
// readable from the edge of vision -- a tick in a corner would be missed.
// Haptics say the same thing on native; this is the half that works everywhere.
//
// Derived straight from the caller's feedback rather than animated through its
// own state: the parent already decides how long a result stands, so a second
// timer here could only disagree with it. Low opacity so it reads as a tint on
// the picture rather than a strobe over it.
function FlashOverlay({ flash }: { flash: 'ok' | 'error' | null }) {
  if (!flash) return null;
  return (
    <View
      pointerEvents="none"
      style={[styles.flash, { backgroundColor: flash === 'ok' ? '#1E8E3E' : '#C0392B' }]}
    />
  );
}

// Replaces the silent `if (!permission.granted) return;` used for the optional
// product photo. That is tolerable for a photo and unusable for a scanner: the
// button would appear to do nothing, for ever, with no way to find out why.
function CameraUnavailable({
  status,
  detail,
  onRequestPermission,
}: {
  status: CameraStatus;
  detail?: string | null;
  onRequestPermission?: () => void;
}) {
  if (status === 'checking') {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.placeholderText}>Checking camera access…</Text>
      </View>
    );
  }

  const copy =
    status === 'prompt'
      ? 'Ka Iibi needs the camera to scan barcodes.'
      : status === 'blocked'
        ? Platform.OS === 'web'
          ? 'Camera access is blocked. Enable it for this site in your browser settings, then reopen the scanner.'
          : 'Camera access is turned off for Ka Iibi.'
        : 'No camera available on this device.';

  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderTitle}>{copy}</Text>
      {detail && <Text style={styles.placeholderText}>{detail}</Text>}
      <Text style={styles.placeholderText}>You can still type or scan a code below.</Text>
      {status === 'prompt' && onRequestPermission && (
        <Pressable onPress={onRequestPermission} style={styles.primary}>
          <Text style={styles.primaryText}>Allow camera</Text>
        </Pressable>
      )}
      {status === 'blocked' && Platform.OS !== 'web' && (
        <Pressable onPress={() => Linking.openSettings()} style={styles.primary}>
          <Text style={styles.primaryText}>Open Settings</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, width: '100%', maxWidth: 560, height: '90%', overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#ECECEC' },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  torch: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  torchOn: { backgroundColor: '#111111' },
  torchText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  torchTextOn: { color: '#FFFFFF' },
  close: { backgroundColor: '#F2F2F2', paddingVertical: 7, paddingHorizontal: 14, borderRadius: 8 },
  closePressed: { opacity: 0.6 },
  closeText: { fontSize: 13, fontWeight: '700', color: '#111111' },
  viewport: { flex: 1, backgroundColor: '#111111', overflow: 'hidden' },
  flash: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.28 },
  reticle: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, margin: 44 },
  corner: { position: 'absolute', width: 34, height: 34, borderColor: '#FFFFFF' },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 26, gap: 10 },
  placeholderTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  placeholderText: { color: '#BBBBBB', fontSize: 12, textAlign: 'center', lineHeight: 17 },
  primary: { backgroundColor: '#FFFFFF', borderRadius: 9, paddingHorizontal: 16, paddingVertical: 10, marginTop: 6 },
  primaryText: { color: '#111111', fontWeight: '800', fontSize: 13 },
  footer: { padding: 14, borderTopWidth: 1, borderTopColor: '#ECECEC' },
  hint: { color: '#999999', fontSize: 11, marginBottom: 10 },
  manualRow: { flexDirection: 'row', gap: 8 },
  manualInput: { flex: 1, backgroundColor: '#F2F2F2', borderRadius: 9, paddingHorizontal: 11, height: 43, color: '#111111' },
  manualGo: { backgroundColor: '#111111', borderRadius: 9, paddingHorizontal: 16, justifyContent: 'center' },
  manualGoDisabled: { backgroundColor: '#CCCCCC' },
  manualGoText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
});
