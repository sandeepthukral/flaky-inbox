const enc = new TextEncoder();

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', enc.encode(s));
}

// Hash both sides so lengths match, compare in constant time, and look at every candidate.
export async function isTokenValid(
  header: string | null,
  domain: string,
  tokens: Record<string, string[]>,
): Promise<boolean> {
  if (!header) return false;
  const candidates = tokens[domain.toLowerCase()] ?? [];
  const given = await sha256(header);
  let ok = false;
  for (const t of candidates) {
    const expected = await sha256(t);
    const eq = (
      crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }
    ).timingSafeEqual(given, expected);
    ok = ok || eq;
  }
  return ok;
}
