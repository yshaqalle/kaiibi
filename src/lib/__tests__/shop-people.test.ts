import {
  alsoOwnedNames,
  branchAccessLabel,
  branchesLabel,
  branchLine,
  cityLabel,
  contactPhone,
  personMatchesQuery,
  seatsLabel,
  seatsScope,
  shortName,
  sortPeople,
  teamSummary,
  type Branch,
  type ShopPerson,
} from '@/lib/shop-people';

function person(over: Partial<ShopPerson> & { userId: string }): ShopPerson {
  return {
    shopId: 'shop-1',
    name: 'Somebody',
    email: 'somebody@example.test',
    phone: null,
    roleName: 'Cashier',
    permissions: [],
    isOwner: false,
    active: true,
    joinedAt: '2026-08-03T09:00:00Z',
    branchNames: [],
    ...over,
  };
}

function branch(over: Partial<Branch> & { id: string }): Branch {
  return {
    name: 'Main',
    city: 'Hargeisa',
    neighborhood: null,
    phone: null,
    isPrimary: false,
    ...over,
  };
}

describe('branchAccessLabel', () => {
  // The rule can_access_location() enforces: no assignment rows means EVERY
  // branch. Rendering that as "no branches" would state the opposite.
  it('reads an empty assignment list as every branch', () => {
    expect(branchAccessLabel(person({ userId: 'u1' }), 2)).toBe('Both branches');
  });

  it('says "All branches" once there are more than two', () => {
    expect(branchAccessLabel(person({ userId: 'u1' }), 3)).toBe('All branches');
  });

  // A single-branch store has no access question to answer.
  it('says nothing when the store has one branch', () => {
    expect(branchAccessLabel(person({ userId: 'u1' }), 1)).toBe('');
  });

  it('names the one branch a member is tied to', () => {
    expect(branchAccessLabel(person({ userId: 'u1', branchNames: ['Koodbuur'] }), 2)).toBe('Koodbuur');
  });

  it('counts when a member is tied to several but not all', () => {
    expect(branchAccessLabel(person({ userId: 'u1', branchNames: ['Koodbuur', 'Main'] }), 4)).toBe('2 branches');
  });

  // Ownership is not an assignment row, so an owner is never labelled off one.
  it('always gives the owner every branch, whatever their rows say', () => {
    expect(branchAccessLabel(person({ userId: 'u1', isOwner: true, branchNames: ['Main'] }), 3)).toBe('All branches');
  });
});

describe('sortPeople', () => {
  it('puts the owner first, then active people, then those who have left', () => {
    const sorted = sortPeople([
      person({ userId: 'gone', name: 'Cabdi', active: false }),
      person({ userId: 'cashier', name: 'Sahra' }),
      person({ userId: 'owner', name: 'Faadumo', isOwner: true }),
    ]);
    expect(sorted.map((p) => p.userId)).toEqual(['owner', 'cashier', 'gone']);
  });

  it('orders equal people by name so the list does not reshuffle between loads', () => {
    const sorted = sortPeople([person({ userId: 'n', name: 'Nasra' }), person({ userId: 'm', name: 'Maxamed' })]);
    expect(sorted.map((p) => p.name)).toEqual(['Maxamed', 'Nasra']);
  });
});

describe('teamSummary', () => {
  it('names the team and counts who has left', () => {
    expect(
      teamSummary([
        person({ userId: 'o', name: 'Faadumo', isOwner: true }),
        person({ userId: 'a', name: 'Maxamed Aadan' }),
        person({ userId: 'b', name: 'Sahra Ismaaciil' }),
        person({ userId: 'c', name: 'Cabdi Jibriil', active: false }),
      ])
    ).toBe('Maxamed, Sahra · 1 who has left');
  });

  it('is null for a one-person shop, which has no team to summarise', () => {
    expect(teamSummary([person({ userId: 'o', isOwner: true })])).toBeNull();
  });

  it('stops naming people after three and counts the rest', () => {
    expect(
      teamSummary([
        person({ userId: 'o', isOwner: true }),
        person({ userId: '1', name: 'Ayaan A' }),
        person({ userId: '2', name: 'Bashir B' }),
        person({ userId: '3', name: 'Caasho C' }),
        person({ userId: '4', name: 'Deeqa D' }),
      ])
    ).toBe('Ayaan, Bashir, Caasho +1');
  });
});

describe('contactPhone', () => {
  const branches = [branch({ id: 'l1', isPrimary: true, phone: '0634418820' })];

  it('prefers the owner’s own number', () => {
    expect(contactPhone(person({ userId: 'o', isOwner: true, phone: '0637710043' }), branches)).toBe('0637710043');
  });

  it('falls back to the primary branch when the owner has no number', () => {
    expect(contactPhone(person({ userId: 'o', isOwner: true }), branches)).toBe('0634418820');
  });

  it('is null when there is nothing to dial', () => {
    expect(contactPhone(null, [branch({ id: 'l1', isPrimary: true })])).toBeNull();
  });
});

describe('personMatchesQuery', () => {
  const sahra = person({ userId: 'u', name: 'Sahra Ismaaciil', email: 'sahra@hooyo.so', phone: '063 441 8820' });

  it('matches a name case-insensitively', () => {
    expect(personMatchesQuery(sahra, 'sahra')).toBe(true);
  });

  it('matches an email', () => {
    expect(personMatchesQuery(sahra, 'hooyo.so')).toBe(true);
  });

  // Operators read the last four digits off a screen; the stored number has
  // spaces in it, so a raw substring test would miss.
  it('matches the last digits of a phone number regardless of spacing', () => {
    expect(personMatchesQuery(sahra, '8820')).toBe(true);
  });

  it('does not match something absent', () => {
    expect(personMatchesQuery(sahra, 'maxamed')).toBe(false);
  });
});

// Real stores sign up without ever typing a name, and what lands in
// shop_members.full_name is sometimes the whole email address.
describe('shortName', () => {
  it('leaves a real name alone', () => {
    expect(shortName('Faadumo Cabdi')).toBe('Faadumo Cabdi');
  });

  it('shows the local part when the name is an email address', () => {
    expect(shortName('mmooge@gmail.com')).toBe('mmooge');
  });

  // Junk that is merely odd is NOT tidied -- a console that hides bad data is
  // worse than one that shows it.
  it('leaves junk that is not an email exactly as it is', () => {
    expect(shortName('jfykwd')).toBe('jfykwd');
  });

  it('does not mistake a name containing an at-sign for an address', () => {
    expect(shortName('Ali @ GarGar')).toBe('Ali @ GarGar');
  });
});

// The section heading already says "People", so repeating the word in its own
// scope reads as a defect: "PEOPLE · 4 PEOPLE" is what the console showed.
describe('seatsScope', () => {
  it('is the bare count when the plan is uncapped', () => {
    expect(seatsScope(4, null)).toBe('4');
  });

  it('keeps the cap when there is one, because then it is a budget', () => {
    expect(seatsScope(4, 11)).toBe('4 of 11 seats');
  });

  it('says nobody rather than a bare zero', () => {
    expect(seatsScope(0, 11)).toBe('nobody yet');
  });
});

describe('branchLine', () => {
  it('joins a place and a phone', () => {
    expect(branchLine('Jigjiga yar, Hargeisa', '+252-063-9186568')).toBe('Jigjiga yar, Hargeisa · +252-063-9186568');
  });

  it('keeps a phrase for the one thing that is missing', () => {
    expect(branchLine('Jigjiga yar, Hargeisa', null)).toBe('Jigjiga yar, Hargeisa · no phone on file');
    expect(branchLine('', '+252-063-9186568')).toBe('no address on file · +252-063-9186568');
  });

  // "no address on file · no phone on file" says "on file" twice in six words.
  it('collapses to one phrase when both are missing', () => {
    expect(branchLine('', null)).toBe('no address or phone on file');
  });
});

// One person owning two stores changes the conversation from one renewal to
// two, and the console already holds every store, so it is free to work out.
describe('alsoOwnedNames', () => {
  const stores = [
    { shopId: 's1', ownerId: 'u1', shopName: 'Hooyo Market' },
    { shopId: 's2', ownerId: 'u1', shopName: 'Hooyo Wholesale' },
    { shopId: 's3', ownerId: 'u2', shopName: 'Xamdi Pharmacy' },
  ];

  it('names the owner’s other stores', () => {
    expect(alsoOwnedNames('s1', 'u1', stores)).toEqual(['Hooyo Wholesale']);
  });

  it('never includes the store you are looking at', () => {
    expect(alsoOwnedNames('s2', 'u1', stores)).toEqual(['Hooyo Market']);
  });

  it('is empty for someone who owns one store', () => {
    expect(alsoOwnedNames('s3', 'u2', stores)).toEqual([]);
  });

  // Two owners can share nothing but a null id if a read failed.
  it('does not group stores together on a missing owner', () => {
    expect(alsoOwnedNames('s1', '', [{ shopId: 's9', ownerId: '', shopName: 'Nobody' }])).toEqual([]);
  });
});

// A capped plan has a seat count worth showing against its cap. An UNCAPPED
// one does not: "0 of ∞ seats" is how a Trial store's header read on the real
// console, which says nothing and reads like a defect.
describe('seatsLabel', () => {
  it('counts against the cap when there is one', () => {
    expect(seatsLabel(4, 11)).toBe('4 of 11 seats');
  });

  it('just counts people when the plan is uncapped', () => {
    expect(seatsLabel(4, null)).toBe('4 people');
  });

  it('says "1 person", not "1 people"', () => {
    expect(seatsLabel(1, null)).toBe('1 person');
  });

  // The roster failed to load, so a count would be a lie rather than a zero.
  it('says nothing countable when there is nobody to count', () => {
    expect(seatsLabel(0, null)).toBe('nobody yet');
  });
});

describe('branchesLabel', () => {
  it('counts against the cap when there is one', () => {
    expect(branchesLabel(2, 3)).toBe('2 of 3 branches');
  });

  it('just counts branches when the plan is uncapped', () => {
    expect(branchesLabel(2, null)).toBe('2 branches');
  });

  it('says "1 branch", not "1 branches"', () => {
    expect(branchesLabel(1, null)).toBe('1 branch');
  });
});

describe('cityLabel', () => {
  it('names the primary branch’s city', () => {
    expect(cityLabel([branch({ id: 'a', isPrimary: true, city: 'Hargeisa' })])).toBe('Hargeisa');
  });

  it('counts the other branches rather than listing three towns', () => {
    expect(
      cityLabel([
        branch({ id: 'a', isPrimary: true, city: 'Burco' }),
        branch({ id: 'b', city: 'Hargeisa' }),
        branch({ id: 'c', city: 'Berbera' }),
      ])
    ).toBe('Burco +2');
  });

  it('is null when no branch has a city', () => {
    expect(cityLabel([branch({ id: 'a', isPrimary: true, city: null })])).toBeNull();
  });
});
