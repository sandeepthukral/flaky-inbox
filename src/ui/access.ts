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
    });
    const email = payload.email;
    return typeof email === 'string' && email !== '' ? { email } : null;
  } catch {
    return null;
  }
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

export function accessJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}
