import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useLocalPhotoUri } from '@/hooks/use-local-photo-uri';

// The contract: a `blob:` photo is released exactly when a newer pick replaces
// it and when the form unmounts -- and at no other time, because between pick
// and upload the url has to stay alive for the preview and for a submit retry.

function Probe({ initial, onApi }: { initial: string | null; onApi: (api: ReturnType<typeof useLocalPhotoUri>) => void }) {
  onApi(useLocalPhotoUri(initial));
  return <Text>probe</Text>;
}

function render(initial: string | null) {
  let api!: ReturnType<typeof useLocalPhotoUri>;
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<Probe initial={initial} onApi={(a) => { api = a; }} />);
  });
  return {
    tree,
    uri: () => api[0],
    set: (next: string | null) => act(() => api[1](next)),
  };
}

describe('useLocalPhotoUri', () => {
  let revoke: jest.SpyInstance;
  beforeEach(() => { revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); });
  afterEach(() => { revoke.mockRestore(); });

  it('holds the uri like plain state', () => {
    const photo = render(null);
    photo.set('blob:https://till.example/a');
    expect(photo.uri()).toBe('blob:https://till.example/a');
    // Merely holding it must not release it -- the preview is reading it.
    expect(revoke).not.toHaveBeenCalled();
  });

  it('releases a photo the moment a retake replaces it', () => {
    const photo = render(null);
    photo.set('blob:https://till.example/a');
    photo.set('blob:https://till.example/b');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:https://till.example/a');
    expect(photo.uri()).toBe('blob:https://till.example/b');
  });

  it('releases the last photo when the form unmounts', () => {
    const photo = render(null);
    photo.set('blob:https://till.example/a');
    act(() => photo.tree.unmount());
    expect(revoke).toHaveBeenCalledWith('blob:https://till.example/a');
  });

  // Setting the same uri again (a re-render passing state back through) is not
  // a replacement and must not kill the url out from under the preview.
  it('does not release a uri re-set to itself', () => {
    const photo = render(null);
    photo.set('blob:https://till.example/a');
    photo.set('blob:https://till.example/a');
    expect(revoke).not.toHaveBeenCalled();
  });

  // An edit form seeded with the stored https url: clearing or replacing it
  // revokes nothing, and unmount revokes nothing -- there is no object URL
  // anywhere in that story.
  it('never touches stored https urls', () => {
    const photo = render('https://cdn.example/staff.jpg');
    photo.set(null);
    act(() => photo.tree.unmount());
    expect(revoke).not.toHaveBeenCalled();
  });
});
