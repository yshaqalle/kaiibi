import { personInitials, shortPersonName } from '@/lib/user-identity';

describe('shortPersonName', () => {
  it('shortens a full name to a first name and a last initial', () => {
    expect(shortPersonName('Abdi Mohamed')).toBe('Abdi M.');
  });

  it('drops middle names rather than initialising them', () => {
    expect(shortPersonName('Abdi Mohamed Hassan')).toBe('Abdi H.');
  });

  it('leaves a single-word name alone rather than inventing an initial', () => {
    expect(shortPersonName('Abdi')).toBe('Abdi');
  });

  it('collapses stray whitespace before splitting', () => {
    expect(shortPersonName('  Abdi   Mohamed  ')).toBe('Abdi M.');
  });

  it('falls back to the email local part, not the whole address', () => {
    expect(shortPersonName(null, 'abdi@hodanstore.so')).toBe('abdi');
  });

  it('prefers a name over an email when both are present', () => {
    expect(shortPersonName('Abdi Mohamed', 'someone.else@hodanstore.so')).toBe('Abdi M.');
  });

  it('treats a blank name as absent', () => {
    expect(shortPersonName('   ', 'abdi@hodanstore.so')).toBe('abdi');
  });

  it('has something to say when there is neither a name nor an email', () => {
    expect(shortPersonName(null, null)).toBe('Signed in');
  });
});

describe('personInitials', () => {
  it('takes the first and last initial', () => {
    expect(personInitials('Abdi Mohamed')).toBe('AM');
  });

  it('agrees with shortPersonName about which words count', () => {
    expect(personInitials('Abdi Mohamed Hassan')).toBe('AH');
    expect(shortPersonName('Abdi Mohamed Hassan')).toBe('Abdi H.');
  });

  it('gives one letter for a single-word name', () => {
    expect(personInitials('Abdi')).toBe('A');
  });

  it('uppercases a lowercase source', () => {
    expect(personInitials(null, 'abdi.mohamed@hodanstore.so')).toBe('A');
  });

  it('falls back to a placeholder rather than an empty circle', () => {
    expect(personInitials(null, null)).toBe('?');
  });
});
