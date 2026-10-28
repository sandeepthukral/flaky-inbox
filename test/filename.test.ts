import { describe, expect, it } from 'vitest';
import { contentDisposition, sanitizeFilename } from '../src/filename';

describe('sanitizeFilename', () => {
  it('strips paths and control chars', () =>
    expect(sanitizeFilename('../../etc/pa"ss\r\nwd.pdf')).toBe('passwd.pdf'));
  it('defaults empty', () => expect(sanitizeFilename('  ')).toBe('attachment.pdf'));
  it('defaults null and undefined', () => {
    expect(sanitizeFilename(null)).toBe('attachment.pdf');
    expect(sanitizeFilename(undefined)).toBe('attachment.pdf');
  });
  it('takes the basename after backslashes too', () =>
    expect(sanitizeFilename('C:\\Users\\bob\\invoice.pdf')).toBe('invoice.pdf'));
  it('removes tabs', () => expect(sanitizeFilename('a\tb.pdf')).toBe('ab.pdf'));
  it('collapses whitespace and trims dots and spaces', () =>
    expect(sanitizeFilename('  ..my   file..  ')).toBe('my file'));
  it('caps length at 150 characters', () => expect(sanitizeFilename(`${'a'.repeat(300)}.pdf`).length).toBe(150));
});

describe('contentDisposition', () => {
  it('encodes non-ascii', () =>
    expect(contentDisposition('factuur €.pdf')).toBe(
      `attachment; filename="factuur _.pdf"; filename*=UTF-8''factuur%20%E2%82%AC.pdf`,
    ));
  it('gives attachment.pdf for undefined', () =>
    expect(contentDisposition(undefined)).toBe(
      `attachment; filename="attachment.pdf"; filename*=UTF-8''attachment.pdf`,
    ));
  it('produces a header with no CR or LF', () => {
    const header = contentDisposition('evil\r\nSet-Cookie: x=1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
  });
  it('escapes RFC 5987 reserved characters in filename*', () =>
    expect(contentDisposition("it's (1)*.pdf")).toBe(
      `attachment; filename="it's (1)*.pdf"; filename*=UTF-8''it%27s%20%281%29%2A.pdf`,
    ));
});
