import { describe, expect, it } from 'vitest';
import { isAcceptedPdf } from '../src/ingest/pdf';

const pdf = new TextEncoder().encode('%PDF-1.3\n...');

describe('isAcceptedPdf', () => {
  it('accepts magic + type', () => expect(isAcceptedPdf(pdf, 'application/pdf; name="x"', undefined)).toBe(true));
  it('accepts magic + .pdf name with octet-stream', () =>
    expect(isAcceptedPdf(pdf, 'application/octet-stream', 'F.PDF')).toBe(true));
  it('rejects pdf type without magic', () =>
    expect(isAcceptedPdf(new TextEncoder().encode('<html>'), 'application/pdf', 'a.pdf')).toBe(false));
  it('rejects magic with image type and no .pdf name', () =>
    expect(isAcceptedPdf(pdf, 'image/png', 'a.png')).toBe(false));
  it('rejects input shorter than the magic bytes', () =>
    expect(isAcceptedPdf(new TextEncoder().encode('%PD'), 'application/pdf', 'a.pdf')).toBe(false));
  it('rejects when neither type nor name is PDF', () =>
    expect(isAcceptedPdf(pdf, undefined, undefined)).toBe(false));
});
