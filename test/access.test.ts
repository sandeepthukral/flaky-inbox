import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyAccessJwt } from '../src/ui/access';

const ISSUER = 'https://team.test';
const AUD = 'aud-tag';

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: 'RS256', use: 'sig', kid: 'k1' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

function sign(over: { aud?: string; iss?: string; exp?: string | number } = {}): Promise<string> {
  return new SignJWT({ email: 'qa@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setAudience(over.aud ?? AUD)
    .setIssuer(over.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '5m')
    .sign(privateKey);
}

describe('verifyAccessJwt', () => {
  it('accepts valid token and returns email', async () => {
    const out = await verifyAccessJwt(await sign(), { aud: AUD, issuer: ISSUER, jwks });
    expect(out).toEqual({ email: 'qa@example.test' });
  });

  it('rejects wrong aud', async () => {
    const out = await verifyAccessJwt(await sign({ aud: 'other' }), { aud: AUD, issuer: ISSUER, jwks });
    expect(out).toBeNull();
  });

  it('rejects wrong issuer', async () => {
    const out = await verifyAccessJwt(await sign({ iss: 'https://evil.test' }), { aud: AUD, issuer: ISSUER, jwks });
    expect(out).toBeNull();
  });

  it('rejects expired', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const out = await verifyAccessJwt(await sign({ exp: past }), { aud: AUD, issuer: ISSUER, jwks });
    expect(out).toBeNull();
  });

  it('rejects null', async () => {
    expect(await verifyAccessJwt(null, { aud: AUD, issuer: ISSUER, jwks })).toBeNull();
  });
});
