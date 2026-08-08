import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { squareCropFromFrame, type CameraPhotoButtonProps } from '@/components/camera-photo-button-shared';
import { AppModal } from '@/components/ui/app-modal';
import { PHOTO_QUALITY } from '@/lib/photo-picker';

// The browser camera button.
//
// expo-image-picker's `launchCameraAsync` is deliberately NOT used here. Its
// web implementation is a file input carrying the `capture` attribute, which
// only means anything on a phone browser -- every desktop browser ignores it
// and opens the ordinary file dialog, i.e. exactly what the "Choose photo"
// button beside it already does. A laptop with a webcam would get two buttons
// that do the same thing and no way to actually take a picture.
//
// So the browser gets a real capture: getUserMedia into a <video>, a frame
// copied into a <canvas>, out as a jpeg blob. Same approach the web barcode
// scanner already uses (barcode-scanner-modal.web.tsx), including its reasons
// for `facingMode: ideal` and for stopping every track on teardown.

// The longest side of the saved image. A webcam will happily hand over 1080p or
// more, and a product thumbnail gains nothing from it -- this is a shop's data
// budget, and the photo is a square crop of that frame anyway.
const MAX_CAPTURE_PX = 1280;

type CameraStatus = 'checking' | 'ready' | 'blocked' | 'unavailable';

export function CameraPhotoButton({ onCapture, onError, style, accessibilityLabel, children }: CameraPhotoButtonProps) {
  // Starts hidden, not shown: on a desktop with no webcam the button should
  // never appear at all, and appearing-then-vanishing is worse than arriving a
  // frame late.
  const [hasCamera, setHasCamera] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const answer = await detectCamera();
      if (!cancelled) setHasCamera(answer);
    };
    check();
    // A webcam plugged into a till mid-shift should light the button up
    // without a reload.
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    devices?.addEventListener?.('devicechange', check);
    return () => {
      cancelled = true;
      devices?.removeEventListener?.('devicechange', check);
    };
  }, []);

  if (!hasCamera) return null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={style}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        {children}
      </Pressable>
      <WebcamCaptureModal
        visible={open}
        onClose={() => setOpen(false)}
        onCapture={(uri) => {
          setOpen(false);
          onCapture(uri);
        }}
        onError={(message) => {
          setOpen(false);
          onError(message);
        }}
      />
    </>
  );
}

// Whether this browser can open a camera at all.
//
// `enumerateDevices` lists a videoinput entry before any permission is granted
// -- the label is blank, the entry is not -- so the question "is there a
// camera" is answerable without prompting anyone. Anything unexpected answers
// yes, so the failure surfaces inside the modal, where there is room to explain
// it, rather than as a button that silently never exists.
async function detectCamera(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  if (!navigator.mediaDevices.enumerateDevices) return true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === 'videoinput');
  } catch {
    return true;
  }
}

function WebcamCaptureModal({
  visible,
  onClose,
  onCapture,
  onError,
}: {
  visible: boolean;
  onClose: () => void;
  onCapture: (uri: string) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<CameraStatus>('checking');
  const [detail, setDetail] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    cancelledRef.current = false;

    const start = async () => {
      // On a page served over plain http (a LAN dev URL) `mediaDevices` is
      // undefined outright -- the browser's security rule, not a crash.
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        setDetail(
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
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: MAX_CAPTURE_PX }, height: { ideal: MAX_CAPTURE_PX } },
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('blocked');
        } else {
          setStatus('unavailable');
          setDetail((err as { message?: string } | null)?.message ?? null);
        }
        return;
      }

      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video && video.srcObject !== stream) video.srcObject = stream;
      setStatus('ready');
    };

    start();

    return () => {
      cancelledRef.current = true;
      // Without this the camera indicator light stays on after the modal
      // closes, and the next open can fail because the device is still held.
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus('checking');
      setDetail(null);
    };
  }, [visible]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    // videoWidth is 0 until the first frame lands; capturing then yields a
    // blank image rather than an error.
    if (!video || !video.videoWidth || !video.videoHeight) return;

    // Centre-cropped to a square so a webcam photo matches what the OS camera
    // returns on native, where `aspect: [1, 1]` does the same job.
    const crop = squareCropFromFrame(video.videoWidth, video.videoHeight, MAX_CAPTURE_PX);
    const canvas = document.createElement('canvas');
    canvas.width = crop.size;
    canvas.height = crop.size;
    const context = canvas.getContext('2d');
    if (!context) {
      onError('This browser could not save the photo. Choose a photo instead.');
      return;
    }
    context.drawImage(
      video,
      crop.sourceX,
      crop.sourceY,
      crop.sourceSide,
      crop.sourceSide,
      0,
      0,
      crop.size,
      crop.size
    );
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          onError('This browser could not save the photo. Choose a photo instead.');
          return;
        }
        // An object URL, which is what expo-image-picker hands back on web too
        // -- uploadImage already reads `blob:` uris through fetch().blob().
        onCapture(URL.createObjectURL(blob));
      },
      'image/jpeg',
      PHOTO_QUALITY
    );
  }, [onCapture, onError]);

  if (!visible) return null;

  return (
    <AppModal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>Take a photo</Text>
            <Pressable onPress={onClose} style={styles.close} accessibilityRole="button">
              <Text style={styles.closeText}>Cancel</Text>
            </Pressable>
          </View>

          <View style={styles.stage}>
            {/* Never mirrored. A mirrored preview looks natural on a laptop
                right up until the saved photo of a product label reads
                backwards -- what is framed is what is saved. */}
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
              // screen in the native fullscreen player.
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: status === 'ready' ? 'block' : 'none' }}
            />
            {status !== 'ready' && (
              <Text style={styles.stageText}>
                {status === 'checking' && 'Starting the camera…'}
                {status === 'blocked' && 'Camera access was blocked. Allow it in your browser’s address bar, then try again.'}
                {status === 'unavailable' && (detail ?? 'No camera is available in this browser.')}
              </Text>
            )}
          </View>

          <Pressable
            onPress={capture}
            disabled={status !== 'ready'}
            style={[styles.capture, status !== 'ready' && styles.captureDisabled]}
            accessibilityRole="button"
          >
            <Text style={styles.captureText}>Capture</Text>
          </Pressable>
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 20, width: '100%', maxWidth: 520 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  title: { fontSize: 16, fontWeight: '800', color: '#111111' },
  close: { backgroundColor: '#F2F2F2', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  closeText: { fontSize: 13, fontWeight: '800', color: '#111111' },
  stage: { aspectRatio: 1, borderRadius: 12, backgroundColor: '#111111', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  stageText: { color: '#FFFFFF', fontSize: 13, textAlign: 'center', paddingHorizontal: 24, lineHeight: 19 },
  capture: { marginTop: 14, backgroundColor: '#111111', height: 45, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  captureDisabled: { backgroundColor: '#CCCCCC' },
  captureText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13 },
});
