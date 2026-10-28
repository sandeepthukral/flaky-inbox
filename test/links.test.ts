import { describe, expect, it } from 'vitest';
import { extractLinks } from '../src/links';

describe('extractLinks', () => {
  it('decodes &amp; in href', () => {
    expect(extractLinks('<a href="https://x.test/v?a=1&amp;b=2">go</a>', null)).toEqual([
      'https://x.test/v?a=1&b=2',
    ]);
  });
  it('handles single-quoted and unquoted hrefs and numeric entities', () => {
    expect(extractLinks("<a href='https://x.test/a'>a</a><a href=https://x.test/b&#x3f;c=1>b</a>", null)).toEqual([
      'https://x.test/a',
      'https://x.test/b?c=1',
    ]);
  });
  it('html first, then text, deduped', () => {
    const u1 = 'https://x.test/one';
    const u2 = 'https://x.test/two';
    expect(extractLinks(`<a href="${u1}">1</a>`, `see ${u2} and ${u1}`)).toEqual([u1, u2]);
  });
  it('drops mailto, tel, relative and #', () => {
    const html =
      '<a href="mailto:a@b.test">m</a><a href="tel:123">t</a><a href="/rel">r</a><a href="#top">h</a><a href="https://ok.test/">ok</a>';
    expect(extractLinks(html, null)).toEqual(['https://ok.test/']);
  });
  it('strips trailing punctuation from text urls', () => {
    expect(extractLinks(null, 'Go to https://x.test/a.')).toEqual(['https://x.test/a']);
  });
  it('handles null bodies', () => {
    expect(extractLinks(null, null)).toEqual([]);
  });
});
