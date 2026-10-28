const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (m, hex, dec, name) => {
    if (name) return ENTITIES[name.toLowerCase()];
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

function isHttp(v: string): boolean {
  try {
    const p = new URL(v).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export function extractLinks(html: string | null, text: string | null): string[] {
  const found: string[] = [];
  if (html) {
    for (const m of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      found.push(decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim());
    }
  }
  if (text) {
    for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
      found.push(m[0].replace(/[.,;:!?]+$/, ''));
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of found) {
    if (!isHttp(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
