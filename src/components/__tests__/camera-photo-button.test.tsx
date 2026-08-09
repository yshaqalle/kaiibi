import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CameraPhotoButton } from '@/components/camera-photo-button';
import { deviceHasCamera, takePhotoWithCamera } from '@/lib/photo-picker';

jest.mock('@/lib/photo-picker', () => ({
  deviceHasCamera: jest.fn(),
  takePhotoWithCamera: jest.fn(),
}));

const mockedHasCamera = deviceHasCamera as jest.MockedFunction<typeof deviceHasCamera>;
const mockedTakePhoto = takePhotoWithCamera as jest.MockedFunction<typeof takePhotoWithCamera>;

// RN 0.86's `Pressable` is `React.memo(...)` and `findAllByType(Pressable)`
// silently matches zero nodes -- duck-type on the handler instead, as
// search-row.test.tsx does.
function findPressables(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => typeof node.props?.onPress === 'function', { deep: false });
}

async function render() {
  const onCapture = jest.fn();
  const onError = jest.fn();
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(
      <CameraPhotoButton onCapture={onCapture} onError={onError} accessibilityLabel="Take photo">
        <Text>Take photo</Text>
      </CameraPhotoButton>,
    );
  });
  return { tree: tree!, onCapture, onError };
}

beforeEach(() => jest.clearAllMocks());

describe('CameraPhotoButton (native)', () => {
  // The contract in camera-photo-button-shared.ts, now honoured by BOTH
  // halves: a device with no camera renders nothing, so call sites never gate
  // on a platform themselves. The camera-less Android till this app still
  // ships to must not get a primary button that can only fail.
  it('renders nothing on a device with no camera', async () => {
    mockedHasCamera.mockResolvedValue(false);
    const { tree } = await render();
    expect(findPressables(tree)).toHaveLength(0);
  });

  it('renders the button once the device reports a camera', async () => {
    mockedHasCamera.mockResolvedValue(true);
    const { tree } = await render();
    expect(findPressables(tree)).toHaveLength(1);
  });

  it('hands a capture to onCapture', async () => {
    mockedHasCamera.mockResolvedValue(true);
    mockedTakePhoto.mockResolvedValue({ status: 'picked', uri: 'file:///tmp/photo.jpg' });
    const { tree, onCapture, onError } = await render();
    await act(async () => { findPressables(tree)[0].props.onPress(); });
    expect(onCapture).toHaveBeenCalledWith('file:///tmp/photo.jpg');
    expect(onError).not.toHaveBeenCalled();
  });

  // The press-time catch stays even with detection in front of it: detection
  // can err on the side of showing the button, and that path must still talk.
  it('hands a failure to onError', async () => {
    mockedHasCamera.mockResolvedValue(true);
    mockedTakePhoto.mockResolvedValue({ status: 'failed', message: 'No camera is available on this device. Choose a photo instead.' });
    const { tree, onCapture, onError } = await render();
    await act(async () => { findPressables(tree)[0].props.onPress(); });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('No camera'));
    expect(onCapture).not.toHaveBeenCalled();
  });
});
