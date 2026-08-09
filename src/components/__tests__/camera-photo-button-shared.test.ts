import { squareCropFromFrame } from '@/components/camera-photo-button-shared';

// The browser capture has to reproduce by hand what `aspect: [1, 1]` does for
// free on native, against whatever shape a webcam hands over.
describe('squareCropFromFrame', () => {
  it('takes the middle of a wide laptop frame', () => {
    // 1280x720 -- the shape almost every laptop webcam reports.
    const crop = squareCropFromFrame(1280, 720, 1280);

    expect(crop.sourceSide).toBe(720);
    expect(crop.sourceY).toBe(0);
    // 280 either side, so what was centred in the preview stays centred.
    expect(crop.sourceX).toBe(280);
    expect(crop.sourceX + crop.sourceSide).toBe(1280 - crop.sourceX);
  });

  it('takes the middle of a tall phone frame', () => {
    const crop = squareCropFromFrame(720, 1280, 1280);

    expect(crop.sourceSide).toBe(720);
    expect(crop.sourceX).toBe(0);
    expect(crop.sourceY).toBe(280);
  });

  it('caps an oversized frame rather than uploading it whole', () => {
    // A 4K webcam: the square is 2160px, the file written is not.
    expect(squareCropFromFrame(3840, 2160, 1280)).toMatchObject({ sourceSide: 2160, size: 1280 });
  });

  // Upscaling a cheap webcam would cost bytes and add nothing -- the detail
  // isn't there to recover.
  it('never upscales a small frame', () => {
    expect(squareCropFromFrame(640, 480, 1280).size).toBe(480);
  });

  it('leaves an already-square frame alone', () => {
    expect(squareCropFromFrame(1080, 1080, 1280)).toEqual({ sourceX: 0, sourceY: 0, sourceSide: 1080, size: 1080 });
  });
});
