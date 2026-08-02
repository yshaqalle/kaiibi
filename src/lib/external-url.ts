import { Linking, Platform } from 'react-native';

// On web, `Linking.openURL` just calls `window.open(url, '_blank')` under
// the hood — and browsers (mobile ones especially, or with popups blocked)
// sometimes silently reuse the *current* tab for a blocked/failed
// `window.open` instead of a new one, navigating the whole app away to the
// mailto:/wa.me URL. A real `<a target="_blank" rel="noopener">` click is
// far more reliably respected as "open elsewhere, don't touch this tab" by
// browsers/popup blockers. Native has no such tab concept — `Linking.openURL`
// there goes through the OS bridge correctly.
export function openExternalUrl(url: string): void {
  if (Platform.OS !== 'web') {
    Linking.openURL(url).catch(() => {});
    return;
  }
  // @ts-ignore — web-only DOM APIs.
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // @ts-ignore
  document.body.appendChild(a);
  a.click();
  a.remove();
}
