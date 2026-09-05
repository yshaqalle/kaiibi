import { DEFAULT_REMINDER_TEMPLATE, buildReminderText } from '@/lib/reminder';

// The message body is the one part of the reminder feature a shop cannot work
// around if they dislike it, so the substitution rules are pinned here rather
// than discovered in a customer's chat thread.

const vars = {
  customer: 'Amina Hersi',
  shop: 'Hodan Store',
  amount: '$1,240.00',
  due: '5 October',
};

describe('buildReminderText', () => {
  it('fills every placeholder in the shipped default', () => {
    expect(buildReminderText(null, vars)).toBe(
      'Hello Amina Hersi. Your balance at Hodan Store is $1,240.00, due 5 October. Thank you.'
    );
  });

  it('uses the shop’s own words when it has written some', () => {
    expect(buildReminderText('Salaan {customer}, waxaad ku leedahay {shop} {amount}.', vars)).toBe(
      'Salaan Amina Hersi, waxaad ku leedahay Hodan Store $1,240.00.'
    );
  });

  it('falls back to the default when the template is blank or whitespace', () => {
    // A shop that clears the field means "go back to normal", not "send an
    // empty message" -- and WhatsApp would open an empty draft.
    for (const blank of ['', '   ', '\n']) {
      expect(buildReminderText(blank, vars)).toBe(buildReminderText(null, vars));
    }
  });

  it('leaves an unknown placeholder standing rather than deleting it', () => {
    // The whole point: a typo must be VISIBLE in the draft before sending. A
    // silently-removed {amout} produces a message that reads fine and is
    // missing the amount.
    expect(buildReminderText('You owe {amout} to {shop}.', vars)).toBe('You owe {amout} to Hodan Store.');
  });

  it('does not substitute inherited object properties', () => {
    // `'constructor' in vars` is true; Object.hasOwn is not. Without that
    // distinction this would paste a function's source into a customer's
    // message.
    expect(buildReminderText('{constructor}{toString}', vars)).toBe('{constructor}{toString}');
  });

  it('repeats a placeholder used more than once', () => {
    expect(buildReminderText('{customer}, {customer}!', vars)).toBe('Amina Hersi, Amina Hersi!');
  });

  it('ships a default that names every variable it documents', () => {
    // Guards the pairing: a default that stopped mentioning {due} would make
    // the whole due-date feature invisible in the message it exists to send.
    for (const key of ['customer', 'shop', 'amount', 'due']) {
      expect(DEFAULT_REMINDER_TEMPLATE).toContain(`{${key}}`);
    }
  });
});
