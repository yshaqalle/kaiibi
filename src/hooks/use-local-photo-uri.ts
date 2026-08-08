import { useCallback, useEffect, useRef, useState } from 'react';

import { releasePhotoUri } from '@/lib/photo-picker';

// `useState` for a photo uri, plus the bookkeeping a web capture needs: every
// browser photo is a `blob:` object URL whose bytes the browser holds until
// someone gives them back (see releasePhotoUri). The two safe moments to do
// that are folded in here so no form has to remember them:
//
//   - a newer pick replacing an older one -- retaking a photo three times must
//     not keep three photos in memory;
//   - the form unmounting -- by then the preview is gone and any upload has
//     already read the bytes out (uploads happen inside save/submit, which
//     completes before the caller closes).
//
// Upload time is deliberately NOT one of the moments. A submit that uploads
// and then fails later keeps the uri in state for the retry, and a revoked
// url would turn that retry into a broken photo.
//
// Native `file://` uris and stored `https://` urls flow through unchanged --
// releasePhotoUri ignores them -- so callers use this for any photo state, not
// only on web.
export function useLocalPhotoUri(initial: string | null): [string | null, (next: string | null) => void] {
  const [uri, setUri] = useState<string | null>(initial);

  // The ref shadows the state so the unmount cleanup can see the latest value
  // without re-registering on every pick.
  const uriRef = useRef<string | null>(initial);

  const set = useCallback((next: string | null) => {
    if (uriRef.current !== next) releasePhotoUri(uriRef.current);
    uriRef.current = next;
    setUri(next);
  }, []);

  useEffect(() => () => releasePhotoUri(uriRef.current), []);

  return [uri, set];
}
