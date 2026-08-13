import {
  endDateInputToInstant,
  instantToEndDateInput,
  instantToStartDateInput,
  startDateInputToInstant,
} from '@/lib/promotion-dates';

// Deliberately no hardcoded UTC strings anywhere in this file (jest.config.js
// pins TZ to America/New_York, but these functions must be correct on ANY
// machine's local timezone, not just that one) -- every assertion below is a
// round trip or a relative comparison, never a literal instant.

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
});
