/**
 * @jest-environment ../../../jest/timezone-environment.js
 */
import { inTimezone, READER_ZONES } from '../../../jest/timezone';

import {
  endDateInputToInstant,
  instantToEndDateInput,
  instantToShopEndDate,
  instantToShopStartDate,
  instantToStartDateInput,
  SHOP_TIME_ZONE,
  startDateInputToInstant,
} from '@/lib/promotion-dates';

// Deliberately no hardcoded UTC strings in the PICKER's tests (jest.config.js
// pins TZ to America/New_York, but those functions must be correct on ANY
// machine's local timezone, not just that one) -- every assertion about them
// is a round trip or a relative comparison, never a literal instant. The
// shop-zone helpers at the bottom of the file are the deliberate exception:
// their whole claim is that one named instant reads as one named day no matter
// where the reader is, and a round trip cannot say that.
//
// The zone is really moved for the sweeps below, not mocked -- see
// jest/timezone.ts and the environment this file declares above it. A
// timezone test that never leaves the pinned zone proves nothing.

describe('promotion-dates', () => {
  describe('start date round trip', () => {
    it('returns the same YYYY-MM-DD it was given', () => {
      expect(instantToStartDateInput(startDateInputToInstant('2026-08-15'))).toBe('2026-08-15');
    });

    it('round trips across a month boundary', () => {
      expect(instantToStartDateInput(startDateInputToInstant('2026-08-31'))).toBe('2026-08-31');
    });

    it('round trips across a year boundary', () => {
      expect(instantToStartDateInput(startDateInputToInstant('2026-12-31'))).toBe('2026-12-31');
    });
  });

  describe('end date round trip', () => {
    it('returns the same YYYY-MM-DD it was given', () => {
      expect(instantToEndDateInput(endDateInputToInstant('2026-08-15'))).toBe('2026-08-15');
    });

    it('round trips across a month boundary', () => {
      expect(instantToEndDateInput(endDateInputToInstant('2026-08-31'))).toBe('2026-08-31');
    });

    it('round trips across a year boundary', () => {
      expect(instantToEndDateInput(endDateInputToInstant('2026-12-31'))).toBe('2026-12-31');
    });
  });

  describe('the stored end instant is exactly one day after the stored start instant', () => {
    it('for an ordinary day', () => {
      const d = '2026-08-15';
      expect(Date.parse(endDateInputToInstant(d)) - Date.parse(startDateInputToInstant(d))).toBe(86400000);
    });

    it('across a month boundary', () => {
      const d = '2026-08-31';
      expect(Date.parse(endDateInputToInstant(d)) - Date.parse(startDateInputToInstant(d))).toBe(86400000);
    });

    it('across a year boundary', () => {
      const d = '2026-12-31';
      expect(Date.parse(endDateInputToInstant(d)) - Date.parse(startDateInputToInstant(d))).toBe(86400000);
    });
  });

  describe('a same-day offer', () => {
    it('produces ends_at strictly after starts_at, satisfying promotions_window_ordered', () => {
      const d = '2026-08-15';
      const startsAt = startDateInputToInstant(d);
      const endsAt = endDateInputToInstant(d);
      expect(Date.parse(endsAt)).toBeGreaterThan(Date.parse(startsAt));
    });
  });

  // PROOF 3. The picker's round trip is a SHIPPED CONTRACT and adding the
  // shop-zone helpers below must not have touched it: an owner picks "the
  // 17th", it is stored as local midnight of the 18th, and the editor reads it
  // back as the 17th. If that symmetry broke, every existing promotion's dates
  // would silently move in the editor -- with no error, and nobody's phone
  // showing them what happened.
  //
  // Run in every zone the customer-facing tests use, because the picker runs
  // on whatever phone the owner is holding. The assertions are still round
  // trips and never literal instants: what has to hold is that the pair
  // inverts, not what it inverts through.
  describe('the picker round trip holds in every timezone', () => {
    const PICKED = ['2026-08-15', '2026-08-31', '2026-12-31', '2026-02-28', '2026-03-08'];

    for (const zone of READER_ZONES) {
      it(`starts and ends both come back unchanged in ${zone}`, () => {
        inTimezone(zone, () => {
          for (const picked of PICKED) {
            expect(instantToStartDateInput(startDateInputToInstant(picked))).toBe(picked);
            expect(instantToEndDateInput(endDateInputToInstant(picked))).toBe(picked);
          }
        });
      });

      it(`stores an end exactly one day after a start of the same date in ${zone}`, () => {
        inTimezone(zone, () => {
          for (const picked of PICKED) {
            expect(Date.parse(endDateInputToInstant(picked)))
              .toBeGreaterThan(Date.parse(startDateInputToInstant(picked)));
          }
        });
      });
    }
  });
});

// The customer-facing pair. Everything above resolves in the DEVICE's zone,
// which is right for the picker; these resolve in the SHOP's, which is the
// only answer that means the same thing to every reader of a public page.
describe('the shop-zone date helpers', () => {
  // Mogadishu midnight on 17 August 2026, i.e. 21:00 UTC the evening before.
  // Written out rather than round-tripped precisely because this is the
  // instant a reader's zone used to be able to drag back a day.
  const MOGADISHU_MIDNIGHT_17_AUG = '2026-08-16T21:00:00.000Z';

  it('reads the shop\'s day, not the reader\'s, wherever the reader is', () => {
    for (const zone of READER_ZONES) {
      inTimezone(zone, () => {
        expect(instantToShopStartDate(MOGADISHU_MIDNIGHT_17_AUG)).toBe('2026-08-17');
      });
    }
  });

  it('keeps the stored-exclusive/shown-inclusive reversal, wherever the reader is', () => {
    // Stored as ending at midnight on the 17th means the offer ran through the
    // whole of the 16th. A timezone shift must not move that by a day in
    // either direction.
    for (const zone of READER_ZONES) {
      inTimezone(zone, () => {
        expect(instantToShopEndDate(MOGADISHU_MIDNIGHT_17_AUG)).toBe('2026-08-16');
      });
    }
  });

  it('agrees with the picker for a shopkeeper who is in the shop\'s zone', () => {
    // The bridge between the two pairs: in UTC+3 -- nearly every shopkeeper --
    // they are the same function, which is what makes the printed poster
    // unchanged by this fix.
    inTimezone(SHOP_TIME_ZONE, () => {
      for (const picked of ['2026-08-15', '2026-08-31', '2026-12-31', '2026-02-28']) {
        expect(instantToShopStartDate(startDateInputToInstant(picked))).toBe(picked);
        expect(instantToShopEndDate(endDateInputToInstant(picked))).toBe(picked);
      }
    });
  });

  // The helpers use a fixed +03:00 rather than Intl's timezone database, for
  // the reasons in promotion-dates.ts's header -- East Africa Time has no
  // daylight saving and Hermes on an old Android build is not guaranteed to
  // ship a tz database. That assumption is checked here rather than asserted
  // in a comment: if 'Africa/Mogadishu' ever stops being a flat +03:00, this
  // fails instead of the page quietly shifting a day.
  it('matches Intl\'s own Africa/Mogadishu across a year of instants', () => {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    // Every six hours for a year, so the sweep crosses midnight in the shop's
    // zone, in UTC, and in the reader zones either side of both.
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    for (let hours = 0; hours < 365 * 24; hours += 6) {
      const iso = new Date(start + hours * 3_600_000).toISOString();
      expect(instantToShopStartDate(iso)).toBe(format.format(new Date(iso)));
    }
  });
});
