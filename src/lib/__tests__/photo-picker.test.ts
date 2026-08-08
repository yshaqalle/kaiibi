import * as ImagePicker from 'expo-image-picker';

import { PHOTO_QUALITY, pickPhotoFromLibrary, takePhotoWithCamera } from '@/lib/photo-picker';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

const mocked = ImagePicker as jest.Mocked<typeof ImagePicker>;

const granted = { granted: true } as Awaited<ReturnType<typeof ImagePicker.requestCameraPermissionsAsync>>;
const refused = { granted: false } as Awaited<ReturnType<typeof ImagePicker.requestCameraPermissionsAsync>>;
const picked = (uri: string) =>
  ({ canceled: false, assets: [{ uri }] }) as Awaited<ReturnType<typeof ImagePicker.launchCameraAsync>>;
const canceled = { canceled: true, assets: null } as Awaited<ReturnType<typeof ImagePicker.launchCameraAsync>>;

beforeEach(() => jest.clearAllMocks());

describe('takePhotoWithCamera', () => {
  it('returns the captured uri', async () => {
    mocked.requestCameraPermissionsAsync.mockResolvedValue(granted);
    mocked.launchCameraAsync.mockResolvedValue(picked('file:///tmp/photo.jpg'));

    expect(await takePhotoWithCamera()).toEqual({ status: 'picked', uri: 'file:///tmp/photo.jpg' });
  });

  it('asks for the CAMERA permission, not the library one', async () => {
    mocked.requestCameraPermissionsAsync.mockResolvedValue(granted);
    mocked.launchCameraAsync.mockResolvedValue(canceled);

    await takePhotoWithCamera();

    expect(mocked.requestCameraPermissionsAsync).toHaveBeenCalled();
    expect(mocked.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  // The distinction the three-way result exists for: backing out of the camera
  // is not a problem and must not put an error on the screen.
  it('reports a cancel with no message', async () => {
    mocked.requestCameraPermissionsAsync.mockResolvedValue(granted);
    mocked.launchCameraAsync.mockResolvedValue(canceled);

    expect(await takePhotoWithCamera()).toEqual({ status: 'canceled' });
  });

  it('explains a refused permission instead of failing silently', async () => {
    mocked.requestCameraPermissionsAsync.mockResolvedValue(refused);

    const result = await takePhotoWithCamera();

    expect(result.status).toBe('failed');
    expect(result).toHaveProperty('message', expect.stringContaining('Camera access'));
    expect(mocked.launchCameraAsync).not.toHaveBeenCalled();
  });

  // A camera-less Android till is a device this app deliberately still ships
  // to -- see plugins/with-camera-optional.js. It must get an explanation, not
  // an unhandled rejection.
  it('explains a device with no camera', async () => {
    mocked.requestCameraPermissionsAsync.mockResolvedValue(granted);
    mocked.launchCameraAsync.mockRejectedValue(new Error('Camera not available on this device'));

    const result = await takePhotoWithCamera();

    expect(result.status).toBe('failed');
    expect(result).toHaveProperty('message', expect.stringContaining('No camera'));
  });

  it('crops square at the shared quality, matching the browser capture', async () => {
    mocked.requestCameraPermissionsAsync.mockResolvedValue(granted);
    mocked.launchCameraAsync.mockResolvedValue(canceled);

    await takePhotoWithCamera();

    expect(mocked.launchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsEditing: true, aspect: [1, 1], quality: PHOTO_QUALITY })
    );
  });
});

describe('pickPhotoFromLibrary', () => {
  it('returns the chosen uri', async () => {
    mocked.requestMediaLibraryPermissionsAsync.mockResolvedValue(granted);
    mocked.launchImageLibraryAsync.mockResolvedValue(picked('file:///tmp/chosen.png'));

    expect(await pickPhotoFromLibrary()).toEqual({ status: 'picked', uri: 'file:///tmp/chosen.png' });
  });

  it('reports a cancel with no message', async () => {
    mocked.requestMediaLibraryPermissionsAsync.mockResolvedValue(granted);
    mocked.launchImageLibraryAsync.mockResolvedValue(canceled);

    expect(await pickPhotoFromLibrary()).toEqual({ status: 'canceled' });
  });

  it('explains a refused permission', async () => {
    mocked.requestMediaLibraryPermissionsAsync.mockResolvedValue(refused);

    const result = await pickPhotoFromLibrary();

    expect(result.status).toBe('failed');
    expect(result).toHaveProperty('message', expect.stringContaining('Photo access'));
  });

  // Both pickers use the same options object, so a drift in one is a drift in
  // both -- that is the point of it living in one place.
  it('uses the same square crop as the camera', async () => {
    mocked.requestMediaLibraryPermissionsAsync.mockResolvedValue(granted);
    mocked.launchImageLibraryAsync.mockResolvedValue(canceled);

    await pickPhotoFromLibrary();

    expect(mocked.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: PHOTO_QUALITY })
    );
  });
});
