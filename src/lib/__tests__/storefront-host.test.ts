import { slugFromHostname } from '@/lib/storefront-host';

describe('slugFromHostname', () => {
  it('reads the subdomain', () => {
    expect(slugFromHostname('xamdi.kaiibi.com')).toBe('xamdi');
  });

  it('ignores the apex, which is the app itself', () => {
    expect(slugFromHostname('kaiibi.com')).toBeNull();
  });

  it('ignores reserved subdomains', () => {
    expect(slugFromHostname('www.kaiibi.com')).toBeNull();
    expect(slugFromHostname('app.kaiibi.com')).toBeNull();
  });

  it('ignores a host that is not ours at all', () => {
    expect(slugFromHostname('xamdi.example.com')).toBeNull();
  });

  it('ignores localhost and preview hosts, so dev never resolves a shop by accident', () => {
    expect(slugFromHostname('localhost')).toBeNull();
    expect(slugFromHostname('kaiibi-git-branch.vercel.app')).toBeNull();
  });

  it('ignores a nested subdomain rather than guessing which label is the shop', () => {
    expect(slugFromHostname('a.b.kaiibi.com')).toBeNull();
  });

  it('is case insensitive, because hostnames are', () => {
    expect(slugFromHostname('Xamdi.Kaiibi.com')).toBe('xamdi');
  });

  it('takes the domain as an argument so tests and staging can differ', () => {
    expect(slugFromHostname('xamdi.kaiibi.test', 'kaiibi.test')).toBe('xamdi');
  });

  it('rejects a label longer than the 63-character DNS limit', () => {
    const tooLong = 'a'.repeat(64);
    expect(slugFromHostname(`${tooLong}.kaiibi.com`)).toBeNull();
  });

  it('rejects a label with a leading or trailing hyphen', () => {
    expect(slugFromHostname('-xamdi.kaiibi.com')).toBeNull();
    expect(slugFromHostname('xamdi-.kaiibi.com')).toBeNull();
  });
});
