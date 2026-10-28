import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export async function verifyAccessJwt(
  token: string | null,
  opts: { aud: string; issuer: string; jwks: JWTVerifyGetKey },
): Promise<{ email: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, opts.jwks, {
      audience: opts.aud,
      issuer: opts.issuer,
      algorithms: ['RS256'],
      requiredClaims: ['exp'],
    });
    const email = payload.email;
    return typeof email === 'string' && email !== '' ? { email } : null;
  } catch {
    return null;
  }
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

// Test seam only: lets tests supply a local key set instead of fetching Cloudflare's. Never set in production.
let jwksOverride: ((teamDomain: string) => JWTVerifyGetKey) | null = null;
export function setAccessJwksOverrideForTest(fn: ((teamDomain: string) => JWTVerifyGetKey) | null): void {
  jwksOverride = fn;
}

export function accessJwks(teamDomain: string): JWTVerifyGetKey {
  if (jwksOverride) return jwksOverride(teamDomain);
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}
