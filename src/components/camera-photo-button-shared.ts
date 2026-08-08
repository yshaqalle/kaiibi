import type { StyleProp, ViewStyle } from 'react-native';

// The contract both halves of CameraPhotoButton honour.
//
// It lives in its own file for the same reason BarcodeScannerModalProps lives
// in barcode-scanner-frame.tsx: the native and web builds are separate files
// that Metro picks between, and a type declared twice is a type that drifts.
//
// The button owns its own existence. A device with no camera renders nothing,
// so call sites never gate on a platform themselves -- the answer differs per
// browser and can change mid-session when a USB webcam is plugged in, which is
// not something a call site can be expected to track.
export type CameraPhotoButtonProps = {
  // A local uri -- `file://…` on native, `blob:…` on web. Both upload through
  // uploadImage (see src/lib/storage.ts, which handles each).
  onCapture: (uri: string) => void;
  // Only for failures worth reading. A cancel never reaches here.
  onError: (message: string) => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
  children: React.ReactNode;
};

// Where to cut a square out of a camera frame, and how big to write it.
//
// Native never needs this -- `aspect: [1, 1]` has the OS crop for us -- but the
// browser capture has to do it by hand against whatever shape the webcam gives
// (16:9 on most laptops), so the arithmetic is here where it can be tested
// rather than inside a file that only runs with a DOM.
//
// Centre, not top-left: someone framing a product or a face puts it in the
// middle of the preview, and cropping from a corner would cut off what they
// aimed at.
export function squareCropFromFrame(frameWidth: number, frameHeight: number, maxSize: number) {
  const side = Math.min(frameWidth, frameHeight);
  return {
    // Read this square out of the frame...
    sourceX: (frameWidth - side) / 2,
    sourceY: (frameHeight - side) / 2,
    sourceSide: side,
    // ...and write it at this size. Never upscaled: a 480p webcam should
    // produce a small honest image, not a blurry 1280px one.
    size: Math.min(side, maxSize),
  };
}
