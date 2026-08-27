import { Share } from 'react-native';

// Getting a piece of text OUT of the app, on every platform this app runs on,
// with no new dependency.
//
// Two real paths: a browser has a clipboard, and a phone has the share sheet
// -- whose first action is Copy, and which is how a link actually reaches a
// WhatsApp status in the first place. expo-clipboard would mean a new native
// build for one button.
//
// Lives here rather than inside the one component that first needed it
// because there is now more than one place a shop can copy its web address
// from -- the content drawer and the publish bar -- and two implementations
// of "copy" would be two things to fix the day one of them stops working on a
// platform.
//
// Returns whether the text got out, rather than throwing: every caller's next
// move is the same either way (say "Copied", or say it could not), and a
// rejected clipboard write is an ordinary outcome (a browser without
// permission, a share sheet dismissed), not an exception.
export async function copyText(text: string): Promise<boolean> {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
    .navigator?.clipboard;
  try {
    if (clipboard?.writeText) await clipboard.writeText(text);
    else await Share.share({ message: text });
    return true;
  } catch {
    return false;
  }
}
