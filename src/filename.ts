const MAX_LENGTH = 150;
const DEFAULT_NAME = 'attachment.pdf';

/** Reduce an untrusted attachment name to a safe, short basename. */
export function sanitizeFilename(name: string | null | undefined): string {
  const base = (name ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"\\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, MAX_LENGTH);
  return cleaned === '' ? DEFAULT_NAME : cleaned;
}

/** Build a Content-Disposition header value with an ASCII fallback and RFC 5987 filename*. */
export function contentDisposition(name: string | null | undefined): string {
  const safe = sanitizeFilename(name);
  const fallback = safe.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
