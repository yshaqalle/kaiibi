// '@/lib/support-attachments' imports '@/lib/supabase', which constructs the
// real Supabase client at module load and throws without EXPO_PUBLIC_SUPABASE_*
// env vars -- see support.test.ts for the same pattern. Everything under test
// here is pure; this only unblocks the import.
jest.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  attachmentPath,
  checkAttachment,
  describeUploadFailure,
  missedAttachmentNote,
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

  // The bucket's allowed_mime_types would refuse this anyway (20260825000000),
  // but only after the upload has spent someone's data, and only as a 415.
  it('refuses a kind of file the bucket will not hold', () => {
    const result = checkAttachment([], file({ fileName: 'books.zip', contentType: 'application/zip' }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/cannot open that kind of file/i);
  });

  // uploadAttachment sends application/octet-stream for a null type, which is
  // deliberately NOT on the bucket's list -- so "we don't know what this is" is
  // a refusal that was going to happen, made early and in words.
  it('refuses a file whose kind nothing could work out', () => {
    const result = checkAttachment([], file({ fileName: 'notes', contentType: null }));
    expect(result.ok).toBe(false);
  });

  it('still accepts the kinds this feature actually asks people for', () => {
    expect(checkAttachment([], file({ fileName: 'receipt.pdf', contentType: 'application/pdf' })).ok).toBe(true);
    expect(checkAttachment([], file({ fileName: 'clip.mp4', contentType: 'video/mp4' })).ok).toBe(true);
  });
});

// Both refusals are survivable and have DIFFERENT fixes -- shrink it, or send
// something else -- so "didn't attach" alone is what makes someone pick the
// same unsupported file a second time.
describe('describeUploadFailure', () => {
  it('names the size limit when the bucket refused on size', () => {
    expect(describeUploadFailure(new Error('The object exceeded the maximum allowed size'))).toBe('over 10 MB');
  });

  it('names the kind when the bucket refused on type', () => {
    expect(describeUploadFailure(new Error('mime type application/zip is not supported'))).toBe(
      'not a kind we can open'
    );
  });

  it('falls back to something true rather than guessing', () => {
    expect(describeUploadFailure(new Error('Network request failed'))).toBe('it did not go through');
  });
});

describe('missedAttachmentNote', () => {
  it('says nothing when everything landed', () => {
    expect(missedAttachmentNote([])).toBeNull();
  });

  // Points at the reply box, which has a picker of its own now. Until
  // 20260825000700 it could not: a store could only attach on its FIRST
  // message, so this sentence would have been a dead end.
  it('names the file, the reason, and where to try again', () => {
    const note = missedAttachmentNote([{ fileName: 'till.png', reason: 'over 10 MB' }]);
    expect(note).toContain('till.png');
    expect(note).toContain('over 10 MB');
    expect(note).toContain('Reply on the conversation');
  });

  // The same note is shown on four surfaces, and two of them are already inside
  // the conversation. "Reply on the conversation" is followed literally by
  // somebody who is looking at it, and then they cannot find what it meant.
  it('does not tell someone reading the conversation to go and open it', () => {
    const note = missedAttachmentNote([{ fileName: 'till.png', reason: 'over 10 MB' }], 'thread');
    expect(note).toContain('your next reply');
    expect(note).not.toContain('Reply on the conversation');
  });

  it('does not stutter when several files were refused for one reason', () => {
    const note = missedAttachmentNote([
      { fileName: 'a.png', reason: 'over 10 MB' },
      { fileName: 'b.png', reason: 'over 10 MB' },
    ]);
    expect(note).toContain('2 files');
    expect(note?.match(/over 10 MB/g)).toHaveLength(1);
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
