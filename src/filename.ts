const MAX_CODE_POINTS = 150;
const DEFAULT_NAME = 'attachment.pdf';

// A surrogate that is not part of a valid high+low pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Reduce an untrusted attachment name to a safe, short basename. */
export function sanitizeFilename(name: string | null | undefined): string {
  const base = (name ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"\\]/g, '')
    .replace(LONE_SURROGATE, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  // Cap by code point so an emoji is never cut in half.
  const capped = Array.from(cleaned).slice(0, MAX_CODE_POINTS).join('');
  return capped === '' ? DEFAULT_NAME : capped;
}

/** Build a Content-Disposition header value with an ASCII fallback and RFC 5987 filename*. */
export function contentDisposition(name: string | null | undefined): string {
  const safe = sanitizeFilename(name);
  const fallback = safe.replace(/[^\x20-\x7E]/gu, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
