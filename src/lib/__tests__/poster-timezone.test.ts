/**
 * @jest-environment ../../../jest/timezone-environment.js
 */
import { inTimezone, READER_ZONES } from '../../../jest/timezone';

import { offerCopyFor, posterCopyFor } from '@/lib/poster';
import { endDateInputToInstant, startDateInputToInstant } from '@/lib/promotion-dates';
import type { Promotion } from '@/types/models';

// THE OFFER'S WINDOW IS THE SHOP'S, NOT THE READER'S.
//
// offerCopyFor feeds two surfaces from one derivation: the printed poster a
// shopkeeper puts on the door, and the shop's PUBLIC page
// (src/components/storefront/flyer-carousel.tsx). The shopkeeper is in UTC+3,
// so resolving the window in the device's zone was invisible on paper. On the
// public page it is a wrong answer: an offer stored as ending at Mogadishu
// midnight is still the previous afternoon anywhere west of UTC+3, so a
// customer reading from London or Minneapolis -- and Somaliland shops have a
// real diaspora audience -- was shown a last day the offer does not have.
//
// THE ZONE IS REAL IN THESE TESTS, not mocked. jest.config.js pins the suite
// to America/New_York; `inTimezone` (jest/timezone.ts) moves the runtime for
// the duration of a block and refuses to run the block if the move did not
// take. A test for this bug that only ever ran in the ambient zone would pass
// against the bug itself.
//
// 'Africa/Mogadishu' is the platform constant -- see
// supabase/migrations/20260908000320_shop_local_date.sql. There is no
// shops.timezone and these tests must never grow one.

function makePromotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 'p1', shopId: 's1', locationId: null, name: 'Eid weekend',
    discountType: 'percentage', discountValue: 20, scope: 'store', scopeValue: null,
    active: true, startsAt: null, endsAt: null, autoApply: true, archivedAt: null,
    createdAt: '', ...overrides,
  };
}

const BASE = {
  shopName: 'Suuqa Xamar', branch: null, address: null, hours: null, phone: null, headline: null,
  logoUrl: null,
};

// The instants a UTC+3 shopkeeper's own picker actually stores, built by
// running the picker's own functions in the shop's zone rather than by hand.
// A hand-written '2026-08-13T21:00:00.000Z' would be a second implementation
// of the storage rule sitting in a test file, free to be right about the wrong
// thing; this way the fixture is whatever promotions-tab.tsx would have
// written on the owner's phone.
function asStoredByTheShop(picked: { from?: string; through?: string }): Promotion {
  return inTimezone('Africa/Mogadishu', () => makePromotion({
    startsAt: picked.from ? startDateInputToInstant(picked.from) : null,
    endsAt: picked.through ? endDateInputToInstant(picked.through) : null,
  }));
}

describe('the printed poster, for the shopkeeper who is in UTC+3', () => {
  // PROOF 1. This is nearly every shopkeeper, and it is what says the fix is
  // safe: the owner picks a window on their own phone, in the shop's zone, and
  // the paper on the door reads back exactly the days they picked.
  it('prints back the very days the owner picked, as a range', () => {
    const promo = asStoredByTheShop({ from: '2026-08-14', through: '2026-08-16' });
    inTimezone('Africa/Mogadishu', () => {
      expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('Friday 14 — Sunday 16 August');
    });
  });

  it('prints back the last day the owner picked, on an end-only window', () => {
    const promo = asStoredByTheShop({ through: '2026-08-16' });
    inTimezone('Africa/Mogadishu', () => {
      expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('Until Sunday 16 August');
    });
  });

  it('prints back the first day the owner picked, on a start-only window', () => {
    const promo = asStoredByTheShop({ from: '2026-08-14' });
    inTimezone('Africa/Mogadishu', () => {
      expect(posterCopyFor({ ...BASE, promotion: promo }).when).toBe('From Friday 14 August');
    });
  });

  it('still prints no date line at all when the offer has no window', () => {
    inTimezone('Africa/Mogadishu', () => {
      expect(posterCopyFor({ ...BASE, promotion: makePromotion() }).when).toBeNull();
    });
  });
});

describe('the public page, read from anywhere', () => {
  // PROOF 2. Same stored offer, six readers, one answer -- the shop's.
  //
  // Every zone in READER_ZONES is asserted against the SAME literal, rather
  // than against "whatever Mogadishu produced". Comparing the zones to each
  // other would pass if the derivation broke identically everywhere; the
  // literal is what pins it to the right day rather than merely a consistent
  // one.
  const CASES: { name: string; picked: { from?: string; through?: string }; when: string }[] = [
    {
      name: 'a closed window',
      picked: { from: '2026-08-14', through: '2026-08-16' },
      when: 'Friday 14 — Sunday 16 August',
    },
    {
      // The inclusive/exclusive rule under a timezone shift, which is where a
      // fix like this most easily lands a day out: stored as ending at
      // Mogadishu midnight on the 17th, so it ran through the whole of the
      // 16th, and the 16th is what a customer must read -- in every zone.
      name: 'an end-only window',
      picked: { through: '2026-08-16' },
      when: 'Until Sunday 16 August',
    },
    {
      name: 'a start-only window',
      picked: { from: '2026-08-14' },
      when: 'From Friday 14 August',
    },
    {
      // The exclusive end instant is stored in the NEXT month (Mogadishu
      // midnight on 1 September), so a reader whose zone drags it back a day
      // loses the month as well as the day.
      name: 'a window ending on the last day of a month',
      picked: { through: '2026-08-31' },
      when: 'Until Monday 31 August',
    },
    {
      name: 'a window spanning two months',
      picked: { from: '2026-08-28', through: '2026-09-01' },
      when: 'Friday 28 August — Tuesday 1 September',
    },
    {
      // A single day, the shape most sensitive to a one-day slip: start and
      // inclusive end are the same date, and either one moving reads as a
      // different offer.
      name: 'a one-day offer',
      picked: { from: '2026-08-14', through: '2026-08-14' },
      when: 'Friday 14 — Friday 14 August',
    },
    {
      // A year boundary, where a day's slip changes the year printed.
      name: 'a window ending on new year\'s eve',
      picked: { through: '2026-12-31' },
      when: 'Until Thursday 31 December',
    },
  ];

  for (const scenario of CASES) {
    for (const zone of READER_ZONES) {
      it(`shows ${scenario.name} as the shop's days to a reader in ${zone}`, () => {
        const promo = asStoredByTheShop(scenario.picked);
        inTimezone(zone, () => {
          expect(offerCopyFor(promo).when).toBe(scenario.when);
        });
      });
    }
  }

  it('reads identically in every zone, offer for offer', () => {
    // The property behind the cases above, stated once: whatever the words
    // are, a reader's location cannot change them.
    for (const scenario of CASES) {
      const promo = asStoredByTheShop(scenario.picked);
      const rendered = READER_ZONES.map((zone) => inTimezone(zone, () => offerCopyFor(promo).when));
      expect(new Set(rendered).size).toBe(1);
    }
  });

  it('leaves the value and scope alone, which never depended on a zone', () => {
    const promo = asStoredByTheShop({ from: '2026-08-14', through: '2026-08-16' });
    for (const zone of READER_ZONES) {
      inTimezone(zone, () => {
        const copy = offerCopyFor({ ...promo, scope: 'category', scopeValue: 'Shoes' });
        expect(copy.value).toBe('20%');
        expect(copy.scope).toBe('All Shoes');
      });
    }
  });
});

describe('the timezone helper itself', () => {
  // If this ever stops holding, every assertion above becomes decoration --
  // so it is checked rather than assumed. See jest/timezone.ts.
  it('actually moves the runtime, and puts it back', () => {
    const before = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const inside = inTimezone('Pacific/Kiritimati', () => ({
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // A real Date, not just a resolvedOptions string: +14 is a full day
      // ahead of the suite's pinned America/New_York.
      day: new Date('2026-08-16T21:00:00.000Z').getDate(),
    }));
    expect(inside.zone).toBe('Pacific/Kiritimati');
    expect(inside.day).toBe(17);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(before);
    expect(new Date('2026-08-16T21:00:00.000Z').getDate()).toBe(16);
  });
});
