import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

// Opens a sheet from inside another sheet.
//
// The problem this exists for: iOS silently drops a modal presented while
// another is still up. So a screen that renders an AppModal and, from a button
// inside it, renders a second AppModal has a button that does nothing at all on
// an iPhone. Nothing throws and nothing is logged; the sheet simply never
// appears, which is why two of these shipped -- the poster in promotions-tab
// and the send queue in campaigns-tab. The same code is correct on a tablet,
// where TwoPaneListDetail's detail is a pane and not a modal at all, and on
// Android and web, whose modals stack happily.
//
// The fix is the one pos.tsx already uses when the checkout sheet hands over to
// the receipt: close the first sheet, and present the second from its
// `onDismiss`. This packages that so the call sites cannot drift apart, and so
// the next screen to grow a second sheet has something to copy.
//
// `value` is what to show, not a boolean, because every caller needs to know
// WHICH record the second sheet is for.
export function useStagedSheet<T>() {
  const [value, setValue] = useState<T | null>(null);
  const [pending, setPending] = useState<T | null>(null);
  // Whether THIS open() staged, and so whether the presenter must stay closed.
  //
  // Separate from `pending` because `pending` is only set during the handover:
  // once it promotes it goes back to null, and a `presenterSuppressed` derived
  // from it alone would flip false the instant the staged sheet appeared --
  // reopening the presenter on top of it and letting iOS drop the very sheet
  // this hook exists to show. That was the first version of this fix, and on a
  // phone it looked exactly like no fix at all.
  //
  // Separate from `value` too, so that a non-staged open (Android, web, a
  // tablet's always-visible pane) leaves the presenter alone, as it always did.
  const [staged, setStaged] = useState(false);

  const promote = () => {
    if (pending === null) return;
    setValue(pending);
    setPending(null);
  };

  // Safety net, NOT the mechanism -- `onPresenterDismissed` is what normally
  // promotes, and normally wins this race comfortably. It exists because the
  // failure it guards against is the button doing nothing at all, which is the
  // exact bug being fixed: if `onDismiss` ever fails to fire, waiting forever
  // would reintroduce it in a new disguise. Showing the sheet slightly late is
  // always better than not at all. Same reasoning, and same 700ms, as the
  // staged receipt in pos.tsx.
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => {
      setValue(pending);
      setPending(null);
    }, 700);
    return () => clearTimeout(timer);
  }, [pending]);

  return {
    // Non-null while the second sheet should be on screen.
    value,
    // The caller ANDs this into the presenting sheet's `visible`. It stays true
    // for as long as the staged sheet is up, not merely across the handover --
    // see the comment on `staged`.
    presenterSuppressed: staged,
    // `fromModal` is whether the thing being opened FROM is currently a modal.
    // It is the caller's to answer because only the caller knows: the same
    // button lives in a modal sheet on a phone and in an always-visible pane on
    // a tablet. Passing false when it should be true reintroduces the bug;
    // passing true when it should be false costs one animation frame.
    //
    // iOS is the only platform that stages, because it is the only one that
    // drops the second modal -- and RN fires `onDismiss` on iOS alone, so
    // staging elsewhere would wait for a handover that never comes and show
    // nothing, turning a bug on one platform into a bug on three.
    open(next: T, fromModal: boolean) {
      if (Platform.OS === 'ios' && fromModal) {
        setStaged(true);
        setPending(next);
      } else {
        setValue(next);
      }
    },
    close() {
      setValue(null);
      setPending(null);
      setStaged(false);
    },
    // Hand to whichever sheet is being closed to make room -- TwoPaneListDetail's
    // `onDetailDismissed`, the composer's `onDismissed`. Harmless to wire to
    // several: it does nothing unless something is actually staged.
    onPresenterDismissed: promote,
  };
}
