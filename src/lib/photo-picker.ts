import * as ImagePicker from 'expo-image-picker';

// The one place that knows how a photo gets into the app.
//
// Every photo in kaiibi -- a product image, a staff avatar -- is cropped square
// and compressed the same way, so the options live here rather than being
// re-typed at each call site where one of them could quietly drift.
// Exported because the browser capture has to match it by hand: there is no
// expo-image-picker in that path, so camera-photo-button.web.tsx passes this to
// canvas.toBlob itself (and centre-crops to a square for the `aspect` above).
export const PHOTO_QUALITY = 0.8;

const SQUARE_PHOTO: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: PHOTO_QUALITY,
};

// Three outcomes, not two. A cancel and a refusal both leave the photo
// unchanged, but only one of them is worth telling someone about: a cancel was
// their own decision, a refusal means the button will keep doing nothing until
// they change something outside the app.
//
// The reason travels with the result rather than being re-derived by each
// caller, so every screen says the same thing for the same failure.
export type PhotoPick =
  | { status: 'picked'; uri: string }
  | { status: 'canceled' }
  | { status: 'failed'; message: string };

export async function pickPhotoFromLibrary(): Promise<PhotoPick> {
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      return { status: 'failed', message: 'Photo access is off. Turn it on in your device settings to choose a photo.' };
    }
    const picked = await ImagePicker.launchImageLibraryAsync(SQUARE_PHOTO);
    return picked.canceled ? { status: 'canceled' } : { status: 'picked', uri: picked.assets[0].uri };
  } catch {
    return { status: 'failed', message: 'Could not open your photos. Try again.' };
  }
}

export async function takePhotoWithCamera(): Promise<PhotoPick> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return { status: 'failed', message: 'Camera access is off. Turn it on in your device settings to take a photo.' };
    }
    const taken = await ImagePicker.launchCameraAsync(SQUARE_PHOTO);
    return taken.canceled ? { status: 'canceled' } : { status: 'picked', uri: taken.assets[0].uri };
  } catch {
    // Reachable on a device with no camera at all, which this app deliberately
    // still ships to -- plugins/with-camera-optional.js keeps a camera-less
    // Android till in Play's distribution. There is no pre-flight check for
    // that in expo-image-picker, so the failure is caught and explained here
    // rather than surfacing as a button that does nothing.
    return { status: 'failed', message: 'No camera is available on this device. Choose a photo instead.' };
  }
}

// Note there is no `cameraCaptureAvailable` flag here. Whether a camera can be
// offered is not a platform question -- a desktop browser may or may not have a
// webcam, and one can be plugged in mid-session -- so it is answered by
// CameraPhotoButton, which renders nothing when there is no camera to use.

// Gives a `blob:` object URL back to the browser. A web capture or web library
// pick mints one per photo, and the browser holds the bytes alive until the
// page unloads unless someone says otherwise -- this is the someone.
//
// It must NOT be called at upload time: a failed submit keeps the uri in state
// for the retry, and a revoked url reads as a broken photo, not a retryable
// one. The safe moments are when a newer pick replaces it and when the form
// holding it unmounts, which is what use-local-photo-uri.ts arranges.
//
// Everything that isn't a live object URL passes through untouched: native
// `file://` uris, `https://` urls already in storage, and null.
export function releasePhotoUri(uri: string | null | undefined): void {
  if (!uri?.startsWith('blob:')) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(uri);
}
