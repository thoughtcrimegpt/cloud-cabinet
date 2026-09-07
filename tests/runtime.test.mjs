import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MfResponse,
} from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

test(
  'built Worker enforces access and immutable history with real D1 and R2',
  { timeout: 60000 },
  async (t) => {
    const root = join(import.meta.dirname, '..');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'runtime-key',
      alg: 'RS256',
      use: 'sig',
    };
    const domain = 'https://runtime-test.cloudflareaccess.com',
      aud = 'a'.repeat(64);
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        name: 'cabinet',
        scriptPath: join(root, '.build', 'index.js'),
        modules: true,
        compatibilityDate: '2026-09-07',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['FILES'],
        bindings: {
          ACCESS_TEAM_DOMAIN: domain,
          ACCESS_AUD: aud,
          OWNER_EMAIL: 'owner@example.com',
          MAX_STORAGE_BYTES: '1000000',
        },
        outboundService: async (request) =>
          request.url === domain + '/cdn-cgi/access/certs'
            ? MfResponse.json({ keys: [jwk] })
            : new MfResponse('Blocked by test', { status: 502 }),
      }),
    );
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('DB');
    for (const file of readdirSync(join(root, 'migrations'))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      const statements = readFileSync(join(root, 'migrations', file), 'utf8')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      await db.batch(statements.map((sql) => db.prepare(sql)));
    }
    const tokens = new Map();
    for (const email of [
      'owner@example.com',
      'viewer@example.com',
      'editor@example.com',
    ]) {
      tokens.set(
        email,
        await new SignJWT({ email })
          .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
          .setIssuer(domain)
          .setAudience(aud)
          .setSubject(email)
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey),
      );
    }
    const call = (path, method = 'GET', data, identity = 'owner@example.com') =>
      mf.dispatchFetch('https://cabinet.test' + path, {
        method,
        headers: {
          Origin: 'https://cabinet.test',
          'Cf-Access-Jwt-Assertion': tokens.get(identity),
          ...(typeof data === 'object'
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body:
          data === undefined
            ? undefined
            : typeof data === 'object'
              ? JSON.stringify(data)
              : data,
      });
    const parse = async (response, status) => {
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    };
    assert.equal(
      (await mf.dispatchFetch('https://cabinet.test/api/me')).status,
      401,
    );
    const folder = (
      await parse(
        await call('/api/folders', 'POST', { name: 'Documents' }),
        201,
      )
    ).entry;
    const prepare = async (data, user) =>
      parse(await call('/api/uploads', 'POST', data, user), 201);
    const first = await prepare({
      parentId: folder.id,
      name: 'notes.txt',
      mime: 'text/plain',
      size: 3,
    });
    const file = (await parse(await call(first.url, 'PUT', 'one'), 200)).entry;
    const next = await prepare({
      entryId: file.id,
      baseVersion: file.currentVersion,
      name: file.name,
      mime: 'text/plain',
      size: 3,
    });
    const updated = (await parse(await call(next.url, 'PUT', 'two'), 200))
      .entry;
    assert.notEqual(updated.currentVersion, file.currentVersion);
    assert.equal(
      await (
        await call(
          `/api/entries/${file.id}/download?version=${file.currentVersion}`,
        )
      ).text(),
      'one',
    );
    const restored = (
      await parse(
        await call(
          `/api/entries/${file.id}/versions/${file.currentVersion}/restore`,
          'POST',
          { baseVersion: updated.currentVersion },
        ),
        200,
      )
    ).entry;
    assert.notEqual(restored.currentVersion, file.currentVersion);
    assert.equal(
      await (await call(`/api/entries/${file.id}/download`)).text(),
      'one',
    );
    await parse(
      await call(`/api/entries/${folder.id}/access`, 'PUT', {
        grants: [
          { email: 'viewer@example.com', role: 'viewer' },
          { email: 'editor@example.com', role: 'editor' },
        ],
      }),
      200,
    );
    assert.equal(
      (
        await call(
          `/api/entries/${file.id}/download`,
          'GET',
          undefined,
          'viewer@example.com',
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          `/api/entries/${file.id}`,
          'PATCH',
          { name: 'bad' },
          'viewer@example.com',
        )
      ).status,
      404,
    );
    const pending = await prepare(
      {
        entryId: file.id,
        baseVersion: restored.currentVersion,
        name: file.name,
        mime: 'text/plain',
        size: 3,
      },
      'editor@example.com',
    );
    await parse(
      await call(`/api/entries/${folder.id}/access`, 'PUT', { grants: [] }),
      200,
    );
    assert.equal(
      (await call(pending.url, 'PUT', 'bad', 'editor@example.com')).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/api/entries/${file.id}/download`,
          'GET',
          undefined,
          'viewer@example.com',
        )
      ).status,
      404,
    );
    const index = await parse(await call('/api/export'), 200);
    assert.equal(index.versions.length, 3);
    assert.equal(new Set(index.versions.map((v) => v.objectKey)).size, 2);
    assert.ok(index.versions.every((v) => /^[a-f0-9]{64}$/.test(v.sha256)));
  },
);
