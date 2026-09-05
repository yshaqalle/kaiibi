/**
 * The words a shop sends when it asks to be paid.
 *
 * Pure and database-free on purpose: this is the one part of the reminder
 * feature the shop cannot work around if they dislike it, so it needs to be
 * readable in one screen and testable without a running app.
 *
 * WHY A TEMPLATE AND NOT A FIXED STRING. A debt reminder is not a receipt. A
 * receipt is a document and can be machine-worded; this is a social act, sent
 * to somebody the shopkeeper knows by name, and the difference between a
 * courtesy and an accusation is entirely in the phrasing. It also goes to a
 * Somali-speaking customer, and a shop that finds our English stiff would
 * otherwise have to retype it in WhatsApp every single time -- which is the
 * same as not having the feature.
 *
 * The template is stored on shops.reminder_template (20261026000100) and is
 * NULL until a shop edits it, so improving the default below reaches every
 * shop that never had an opinion.
 */

/**
 * Shipped in English, deliberately short, and with no threat in it.
 *
 * Short because it is read on a phone, in a chat thread, next to messages from
 * the sender's family -- and because every additional clause is another thing
 * to translate when a shop rewrites this in Somali. It states the amount, the
 * date and who is asking, which is the whole of what the customer needs to
 * act, and then stops.
 *
 * No "please pay immediately", no consequence, no total of how many sales it
 * covers. A shop that wants a firmer tone can write one; a default that
 * arrives pre-annoyed cannot be softened by a shop that never opens Settings.
 */
export const DEFAULT_REMINDER_TEMPLATE =
  'Hello {customer}. Your balance at {shop} is {amount}, due {due}. Thank you.';

/**
 * Everything a reminder can say, already formatted.
 *
 * Strings rather than a cents integer and a Date: money and dates are
 * formatted differently by screen and by locale, and this module having its
 * own opinion about either is how the message ends up disagreeing with the
 * table it was sent from. The caller formats, using the same helpers the row
 * beside the button uses.
 */
export type ReminderVars = {
  customer: string;
  shop: string;
  amount: string;
  due: string;
};

/** The placeholders a shop may use, for the Settings hint that lists them. */
export const REMINDER_PLACEHOLDERS: (keyof ReminderVars)[] = ['customer', 'shop', 'amount', 'due'];

/**
 * Fill a template. Blank or missing means the default.
 *
 * An UNKNOWN placeholder is left standing in the text exactly as written --
 * `{amout}` comes out as `{amout}`. That is the deliberate choice over
 * deleting it: a shopkeeper who mistypes one sees the mistake in the WhatsApp
 * draft before they send it, whereas a silently-removed placeholder produces a
 * message that reads fine and is missing the amount. It is the same reasoning
 * that keeps a CHECK constraint off the column -- catch it where it can be
 * seen and fixed, not where it blocks saving a settings screen.
 *
 * A template that is present but blank falls back too. An empty message is
 * never what someone meant, and WhatsApp would open an empty draft.
 */
export function buildReminderText(template: string | null | undefined, vars: ReminderVars): string {
  const source = template?.trim() ? template : DEFAULT_REMINDER_TEMPLATE;
  return source.replace(/\{(\w+)\}/g, (whole, key: string) =>
    // Object.hasOwn, not `key in vars`: `{constructor}` and `{toString}` are
    // both `in` any object and would substitute a function's source code into
    // a customer's message.
    Object.hasOwn(vars, key) ? vars[key as keyof ReminderVars] : whole
  );
}
