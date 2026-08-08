import { Pressable } from 'react-native';

import type { CameraPhotoButtonProps } from '@/components/camera-photo-button-shared';
import { takePhotoWithCamera } from '@/lib/photo-picker';

// The native camera button.
//
// Nothing to render but a Pressable: iOS and Android both hand the whole
// capture experience to the OS camera UI via expo-image-picker, including the
// square crop. The web build next door has to draw all of that itself -- see
// camera-photo-button.web.tsx.
export function CameraPhotoButton({ onCapture, onError, style, accessibilityLabel, children }: CameraPhotoButtonProps) {
  const press = async () => {
    const taken = await takePhotoWithCamera();
    if (taken.status === 'picked') onCapture(taken.uri);
    if (taken.status === 'failed') onError(taken.message);
  };

  return (
    <Pressable onPress={press} style={style} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      {children}
    </Pressable>
  );
}
