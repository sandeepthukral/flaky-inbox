import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTokenValid } from '../src/api/auth';
import { parseApiTokens } from '../src/config';

const tokens = { 'staging.test.example': ['a', 'b'], 'prod.test.example': ['p'] };

describe('isTokenValid', () => {
  it('accepts either of two tokens', async () => {
    expect(await isTokenValid('a', 'staging.test.example', tokens)).toBe(true);
    expect(await isTokenValid('b', 'staging.test.example', tokens)).toBe(true);
  });
  it("rejects other domain's token", async () => {
    expect(await isTokenValid('p', 'staging.test.example', tokens)).toBe(false);
  });
  it('rejects Bearer prefix', async () => {
    expect(await isTokenValid('Bearer a', 'staging.test.example', tokens)).toBe(false);
  });
  it('rejects null and domains without tokens', async () => {
    expect(await isTokenValid(null, 'staging.test.example', tokens)).toBe(false);
    expect(await isTokenValid('a', 'other.test.example', tokens)).toBe(false);
  });
});

describe('parseApiTokens', () => {
  afterEach(() => vi.restoreAllMocks());
  it('fails closed on bad JSON', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseApiTokens('{nope')).toEqual({});
    expect(spy).toHaveBeenCalled();
  });
  it('fails closed on wrong shape', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseApiTokens('["x"]')).toEqual({});
    expect(parseApiTokens('{"d":"tok"}')).toEqual({});
  });
  it('lowercases keys, truncates to 2, drops empties', () => {
    expect(parseApiTokens('{"D.Test":["a","","b","c"]}')).toEqual({ 'd.test': ['a', 'b'] });
    expect(parseApiTokens(undefined)).toEqual({});
  });
});
