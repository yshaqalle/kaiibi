import { usualStore } from '@/lib/customer-segments';

// "Where does this customer shop" is a claim about their habit, so the cases
// that matter are the ones where the data doesn't actually support a claim.

function line(saleId: string, locationId: string) {
  return { saleId, locationId };
}

describe('usualStore', () => {
  it('names the store with the most visits', () => {
    const result = usualStore([line('s1', 'a'), line('s2', 'a'), line('s3', 'b')]);
    expect(result).toEqual({ locationId: 'a', visits: 2, totalVisits: 3 });
  });

  // The load-bearing case: a six-item basket is ONE visit. Counting line items
  // would let a single large shop outvote several separate trips elsewhere.
  it('counts visits, not items', () => {
    const result = usualStore([
      line('s1', 'a'), line('s1', 'a'), line('s1', 'a'), line('s1', 'a'), line('s1', 'a'),
      line('s2', 'b'),
      line('s3', 'b'),
    ]);
    expect(result?.locationId).toBe('b');
    expect(result?.totalVisits).toBe(3);
  });

  // Naming either store here would be a coin flip presented as a fact.
  it('returns null on a tie rather than picking one', () => {
    expect(usualStore([line('s1', 'a'), line('s2', 'b')])).toBeNull();
    expect(usualStore([line('s1', 'a'), line('s2', 'a'), line('s3', 'b'), line('s4', 'b')])).toBeNull();
  });

  it('returns null with no purchases', () => {
    expect(usualStore([])).toBeNull();
  });

  it('handles a single visit', () => {
    expect(usualStore([line('s1', 'a')])).toEqual({ locationId: 'a', visits: 1, totalVisits: 1 });
  });

  // A clear leader still wins even when the rest are tied behind it.
  it('is unaffected by a tie below the top', () => {
    const result = usualStore([
      line('s1', 'a'), line('s2', 'a'), line('s3', 'a'),
      line('s4', 'b'),
      line('s5', 'c'),
    ]);
    expect(result?.locationId).toBe('a');
  });
});
