import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import worker from '../src/index.ts';
import { makeEnv } from './helpers.mjs';

const realFetch = globalThis.fetch;
let setupNumber = 0;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

async function setup() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  globalThis.fetch = async (url) =>
    url.includes('/cdn-cgi/access/certs')
      ? Response.json({ keys: [jwk] })
      : Response.json({});
  const env = {
    ...makeEnv(),
    ACCESS_TEAM_DOMAIN: `https://team-${++setupNumber}.cloudflareaccess.com`,
    ACCESS_AUD: 'a'.repeat(64),
    ASSETS: { fetch: async () => new Response('asset') },
  };
  async function token(email, claims = {}) {
    return new SignJWT({ email, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(env.ACCESS_TEAM_DOMAIN)
      .setAudience(env.ACCESS_AUD)
      .setSubject('subject')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  }
  return { env, token, privateKey };
}

test('setup reports unconfigured and API remains fail-closed without valid Access configuration', async () => {
  const env = {
    ...makeEnv(),
    ASSETS: { fetch: async () => new Response('asset') },
  };
  const setupResponse = await worker.fetch(
    new Request('https://cabinet.test/api/setup'),
    env,
  );
  assert.deepEqual(await setupResponse.json(), { configured: false });
  const apiResponse = await worker.fetch(
    new Request('https://cabinet.test/api/me'),
    env,
  );
  assert.equal(apiResponse.status, 503);
});

test('valid owner and non-owner Access JWTs authenticate with normalized identity', async () => {
  const { env, token } = await setup();
  for (const [email, isOwner] of [
    ['OWNER@example.com', true],
    ['user@example.com', false],
  ]) {
    const response = await worker.fetch(
      new Request('https://cabinet.test/api/me', {
        headers: { 'Cf-Access-Jwt-Assertion': await token(email) },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.email, email.toLowerCase());
    assert.equal(body.isOwner, isOwner);
  }
});

test('forged, wrong-audience, wrong-issuer, expired, and missing JWTs are rejected', async () => {
  const { env, token, privateKey } = await setup();
  const wrongAudience = await new SignJWT({ email: 'user@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(env.ACCESS_TEAM_DOMAIN)
    .setAudience('wrong')
    .setSubject('subject')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  const wrongIssuer = await new SignJWT({ email: 'user@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://other.cloudflareaccess.com')
    .setAudience(env.ACCESS_AUD)
    .setSubject('subject')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  const expired = await new SignJWT({ email: 'user@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(env.ACCESS_TEAM_DOMAIN)
    .setAudience(env.ACCESS_AUD)
    .setSubject('subject')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
    .sign(privateKey);
  for (const assertion of [
    null,
    'not-a-jwt',
    wrongAudience,
    wrongIssuer,
    expired,
  ]) {
    const headers = assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {};
    assert.equal(
      (
        await worker.fetch(
          new Request('https://cabinet.test/api/me', { headers }),
          env,
        )
      ).status,
      401,
    );
  }
});

test('mutating requests require exact same-origin even with a valid Access JWT', async () => {
  const { env, token } = await setup();
  const assertion = await token('owner@example.com');
  const response = await worker.fetch(
    new Request('https://cabinet.test/api/folders', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.test',
        'Cf-Access-Jwt-Assertion': assertion,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'escape' }),
    }),
    env,
  );
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /origin/i);
});

test('maintenance keeps authenticated reads available and blocks writes and OAuth callbacks', async () => {
  const { env, token } = await setup();
  env.MAINTENANCE_MODE = 'true';
  const assertion = await token('owner@example.com');
  const headers = { Origin: 'https://cabinet.test', 'Cf-Access-Jwt-Assertion': assertion };
  const me = await worker.fetch(new Request('https://cabinet.test/api/me', { headers }), env);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).maintenance, true);
  const files = await worker.fetch(new Request('https://cabinet.test/api/entries', { headers }), env);
  assert.equal(files.status, 200);
  for (const [path, method] of [['/api/folders', 'POST'], ['/api/gmail/callback?code=fake&state=fake', 'GET']]) {
    const result = await worker.fetch(new Request('https://cabinet.test' + path, { method, headers }), env);
    assert.equal(result.status, 503);
  }
  env.DB = { prepare() { throw Error('Maintenance must not poll Gmail'); } };
  await worker.scheduled({}, env);
});
