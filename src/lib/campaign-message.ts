// One message, written once, addressed per person.
//
// The owner writes "Hi {name} — {offer} at {shop} until {ends}" and every chat
// opens with that customer's own name already in it. The placeholders are a
// fixed set rather than free-form templating: this text is going to a customer
// over WhatsApp, and an expression language would be a way to send something
// nobody proof-read.
export type MessageValues = {
  name: string;
  shop: string;
  offer: string;
  ends: string;
  branch: string;
};

export const PLACEHOLDERS = ['{name}', '{shop}', '{offer}', '{ends}', '{branch}'] as const;

// A single left-to-right pass, NOT five sequential replaces.
//
// Sequential replacement would re-expand its own output: a shop named "{name}"
// would become the customer's name on the following pass. One pass over the
// original string cannot do that, because nothing it writes is ever read again.
export function fillMessage(template: string, values: MessageValues): string {
  return template.replace(/\{(name|shop|offer|ends|branch)\}/g, (match, key: keyof MessageValues) => {
    const value = values[key];
    // An unknown placeholder never reaches here (the pattern only matches the
    // five), and is therefore left visible in the draft rather than silently
    // blanked -- an owner can see and fix "{total}", but not a gap.
    return value ?? match;
  });
}
