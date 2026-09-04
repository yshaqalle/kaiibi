import { getMyStorefront, isValidTradingSince, normalizeInstagram } from '@/lib/storefront-admin';

// `mock`-prefixed: jest.mock's factory is hoisted above this line.
const mockSelect = jest.fn();

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: (columns: string) => {
        mockSelect(columns);
        return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
      },
    }),
  },
}));

// THE REGRESSION THIS EXISTS FOR.
//
// `trading_since` was added to the table, to the public RPC, to the type, to
// the editor's preview and to a save function -- and left out of the ONE query
// that reads it back. Every symptom pointed somewhere else: the field rendered
// blank on reload despite saving, the preview stat never appeared, and typing
// then deleting a digit wrote null over a year the shop had already set.
//
// Nothing else could catch it. The mapper handles the column correctly, the
// save works, the type is right, and tsc is happy because a missing key on a
// PostgREST row is just `undefined`. The only observable is the SELECT string.
describe('the editor reads back what it writes', () => {
  it('asks for trading_since, which is the column that gets forgotten', async () => {
    await getMyStorefront('shop-1');
    const columns = mockSelect.mock.calls[0][0] as string;
    expect(columns).toContain('trading_since');
  });

  // Every live column the editor renders has to be in that same select. Listed
  // by name rather than by count, so adding one to the query cannot silently
  // satisfy a test about a different one.
  it('asks for every live storefront column the editor shows', async () => {
    await getMyStorefront('shop-1');
    const columns = mockSelect.mock.calls[0][0] as string;
    for (const column of [
      'theme', 'palette', 'headline', 'about', 'hero_image_url', 'offers_delivery',
      'published_at', 'first_published_at', 'auto_advance', 'trading_since', 'instagram', 'draft',
    ]) {
      expect(columns).toContain(column);
    }
  });
});

describe('the year a shop opened', () => {
  it('accepts a real year and clearing it', () => {
    expect(isValidTradingSince(2014)).toBe(true);
    expect(isValidTradingSince(null)).toBe(true);
  });

  // A sanity range, not a business rule -- it rejects a typo, never a shop.
  it('rejects a year no shop has', () => {
    expect(isValidTradingSince(1899)).toBe(false);
    expect(isValidTradingSince(2201)).toBe(false);
    expect(isValidTradingSince(20.5)).toBe(false);
  });
});

// A shop asked for a "handle" will paste a url, type an @, or both. All three
// have to land on the same bare handle, because the page prints the @ itself.
describe('the Instagram handle', () => {
  it('strips a leading @', () => {
    expect(normalizeInstagram('@jiija')).toBe('jiija');
    expect(normalizeInstagram('@@jiija')).toBe('jiija');
  });

  it('reduces a pasted url to the handle', () => {
    expect(normalizeInstagram('https://instagram.com/jiija')).toBe('jiija');
    expect(normalizeInstagram('https://www.instagram.com/jiija/')).toBe('jiija');
    expect(normalizeInstagram('instagram.com/jiija?hl=en')).toBe('jiija');
  });

  it('reads an empty or blank field as cleared, not as an empty handle', () => {
    expect(normalizeInstagram('')).toBeNull();
    expect(normalizeInstagram('   ')).toBeNull();
    expect(normalizeInstagram('@')).toBeNull();
  });

  // The column's own check is 30 characters; truncating here means a shop meets
  // the limit as a shortened handle rather than as a Postgres constraint name.
  it('truncates to the length the column accepts', () => {
    expect(normalizeInstagram('a'.repeat(45))).toHaveLength(30);
  });
});
