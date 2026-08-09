import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';

import type { CameraPhotoButtonProps } from '@/components/camera-photo-button-shared';
import { deviceHasCamera, takePhotoWithCamera } from '@/lib/photo-picker';

// The native camera button.
//
// Nothing to render but a Pressable: iOS and Android both hand the whole
// capture experience to the OS camera UI via expo-image-picker, including the
// square crop. The web build next door has to draw all of that itself -- see
// camera-photo-button.web.tsx.
export function CameraPhotoButton({ onCapture, onError, style, accessibilityLabel, children }: CameraPhotoButtonProps) {
  // Starts hidden, not shown, same as the web half: on a camera-less till the
  // button should never appear at all, and appearing-then-vanishing is worse
  // than arriving a frame late.
  const [hasCamera, setHasCamera] = useState(false);

  useEffect(() => {
    let cancelled = false;
    deviceHasCamera().then((answer) => {
      if (!cancelled) setHasCamera(answer);
    });
    return () => { cancelled = true; };
  }, []);

  const press = async () => {
    const taken = await takePhotoWithCamera();
    if (taken.status === 'picked') onCapture(taken.uri);
    if (taken.status === 'failed') onError(taken.message);
  };

  if (!hasCamera) return null;

  return (
    <Pressable onPress={press} style={style} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      {children}
    </Pressable>
  );
}
