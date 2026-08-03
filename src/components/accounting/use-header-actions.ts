import { useEffect, type ReactNode } from 'react';

// Lets a tab put its own buttons on the screen's title row, which sits above
// the tab bar in the shell (matching People, where the title and its primary
// actions share the top line).
//
// The actions have to travel upward because they belong to the tab -- Export
// needs that tab's filtered rows -- while the header renders before it. The
// alternative, moving the title into each tab, would take the range selector
// down with it and reset the selected range on every tab switch.
//
// `deps` follows the usual hook contract: list whatever the node closes over.
export type HeaderActionsSetter = (node: ReactNode) => void;

export function useHeaderActions(setActions: HeaderActionsSetter, node: ReactNode, deps: unknown[]): void {
  useEffect(() => {
    setActions(node);
    // Cleared on unmount so one tab's buttons never linger over another's.
    return () => setActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setActions, ...deps]);
}
