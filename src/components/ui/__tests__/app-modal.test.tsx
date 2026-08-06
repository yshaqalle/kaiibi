import { Modal } from 'react-native';
import { act, create } from 'react-test-renderer';

import { AppModal } from '@/components/ui/app-modal';

// These guard the fix for the POS freeze. React Native defaults a Modal's
// `supportedOrientations` to `['portrait']`, so a modal opened on a device held
// in landscape force-rotates the whole scene; several doing that in quick
// succession leave iOS with orientation transactions that never commit, and it
// suspends interaction until they do -- a fully drawn screen that takes no
// touches. `AppModal` exists to supply the right value everywhere.
function propsOf(element: React.ReactElement) {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(element);
  });
  return tree!.root.findByType(Modal).props;
}

describe('AppModal', () => {
  it('permits landscape, so opening it sideways cannot force a rotation', () => {
    const { supportedOrientations } = propsOf(<AppModal visible />);
    expect(supportedOrientations).toContain('landscape-left');
    expect(supportedOrientations).toContain('landscape-right');
  });

  it('permits portrait, the orientation every device supports', () => {
    expect(propsOf(<AppModal visible />).supportedOrientations).toContain('portrait');
  });

  // Not merely "some orientations are listed": the invariant is that a modal is
  // never NARROWER than what the app itself declares, because anything missing
  // here is an orientation the device can be held in but the modal will force it
  // out of. app.json grants iPad upside-down, so that has to be in too.
  it('is a superset of every orientation app.json declares', () => {
    const declared = new Set<string>();
    const infoPlist = require('../../../../app.json').expo.ios.infoPlist;
    for (const key of ['UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']) {
      for (const value of infoPlist[key] ?? []) {
        declared.add(
          value
            .replace('UIInterfaceOrientation', '')
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .toLowerCase()
        );
      }
    }
    const permitted = propsOf(<AppModal visible />).supportedOrientations as string[];
    expect([...declared].sort()).toEqual(expect.arrayContaining([]));
    for (const orientation of declared) {
      expect(permitted).toContain(orientation);
    }
  });

  it('lets a caller narrow it deliberately, rather than hardcoding', () => {
    const props = propsOf(<AppModal visible supportedOrientations={['portrait']} />);
    expect(props.supportedOrientations).toEqual(['portrait']);
  });

  it('forwards everything else through to the Modal it wraps', () => {
    const onRequestClose = () => {};
    const props = propsOf(<AppModal visible transparent animationType="slide" onRequestClose={onRequestClose} />);
    expect(props.visible).toBe(true);
    expect(props.transparent).toBe(true);
    expect(props.animationType).toBe('slide');
    expect(props.onRequestClose).toBe(onRequestClose);
  });
});
