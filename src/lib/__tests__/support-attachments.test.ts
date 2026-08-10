// '@/lib/support-attachments' imports '@/lib/supabase', which constructs the
// real Supabase client at module load and throws without EXPO_PUBLIC_SUPABASE_*
// env vars -- see support.test.ts for the same pattern. Everything under test
// here is pure; this only unblocks the import.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  attachmentPath,
  checkAttachment,
  MAX_ATTACHMENTS,
  MAX_BYTES,
  WARN_BYTES,
  type PendingAttachment,
} from '@/lib/support-attachments';

function file(over: Partial<PendingAttachment> = {}): PendingAttachment {
  return { uri: 'file:///tmp/a.png', fileName: 'a.png', byteSize: 1024, contentType: 'image/png', ...over };
}

describe('checkAttachment', () => {
  it('accepts a small file when there is room', () => {
    expect(checkAttachment([], file())).toEqual({ ok: true, warn: null });
  });

  // Named limits, not "too big" -- an error that doesn't say the limit makes
  // the person guess how much to trim.
  it('refuses a file over the size cap and names the cap', () => {
    expect(checkAttachment([], file({ byteSize: MAX_BYTES + 1 }))).toEqual({
      ok: false,
      message: 'That file is over 10 MB. Try a screenshot instead of a video, or send it in two parts.',
    });
  });

  it('refuses more than the count cap and names the cap', () => {
    const full = Array.from({ length: MAX_ATTACHMENTS }, () => file());
    expect(checkAttachment(full, file())).toEqual({
      ok: false,
      message: 'You can attach 5 files to one message. Remove one to add another.',
    });
  });

  // A clip is the most useful bug attachment and the most expensive one on a
  // metered connection, so it warns rather than refusing.
  it('warns but accepts a large file under the cap', () => {
    const result = checkAttachment([], file({ byteSize: WARN_BYTES + 1 }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.warn).toMatch(/may take a while/i);
  });
});

describe('attachmentPath', () => {
  // The first segment must be the shop id -- the bucket policy reads it with
  // storage.foldername(name)[1] and a different shape 403s.
  it('starts with the shop id and keeps the extension', () => {
    const path = attachmentPath('shop-1', 'thread-9', 'cart empty.png', 1754_700_000_000);
    expect(path.startsWith('shop-1/thread-9/')).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
  });

  it('is unique per upload so an upsert:false write never collides', () => {
    const a = attachmentPath('shop-1', 'thread-9', 'a.png', 1);
    const b = attachmentPath('shop-1', 'thread-9', 'a.png', 2);
    expect(a).not.toBe(b);
  });

  it('strips characters that would break the path', () => {
    const path = attachmentPath('shop-1', 'thread-9', 'my report (final)/v2.pdf', 1);
    expect(path.split('/').length).toBe(3);
    expect(path).toMatch(/^shop-1\/thread-9\/[A-Za-z0-9._-]+$/);
  });
});
