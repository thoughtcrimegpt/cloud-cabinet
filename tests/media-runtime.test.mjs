import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as MfResponse,
} from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { migrationStatements } from './sql.mjs';

test('media multipart runtime uses real R2, enforces quota, access, ranges, and validators', { timeout: 120000 }, async (t) => {
  const root = join(import.meta.dirname, '..');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'media-runtime-key', alg: 'RS256', use: 'sig' };
  const domain = 'https://media-runtime.cloudflareaccess.com';
  const aud = 'a'.repeat(64);
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'cabinet-media-runtime',
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
      MAX_STORAGE_BYTES: String(64 * 1024 * 1024),
    },
    outboundService: async (request) => request.url === domain + '/cdn-cgi/access/certs'
      ? MfResponse.json({ keys: [jwk] })
      : new MfResponse('Blocked by test', { status: 502 }),
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(join(root, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    const statements = migrationStatements(readFileSync(join(root, 'migrations', file), 'utf8'));
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  const tokens = new Map();
  for (const email of ['owner@example.com', 'viewer@example.com', 'outsider@example.com']) {
    tokens.set(email, await new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(domain).setAudience(aud).setSubject(email).setIssuedAt().setExpirationTime('1h').sign(privateKey));
  }
  const call = (path, method = 'GET', data, identity = 'owner@example.com', extra = {}) => {
    const isJson = data !== null && typeof data === 'object' && !(data instanceof Uint8Array) && !(data instanceof ArrayBuffer);
    return mf.dispatchFetch('https://cabinet.test' + path, {
    method,
    headers: {
      Origin: 'https://cabinet.test',
      'Cf-Access-Jwt-Assertion': tokens.get(identity),
      ...(isJson ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
    },
    body: data === undefined ? undefined : isJson ? JSON.stringify(data) : data,
    });
  };
  const json = async (response, status) => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };

  const folder = (await json(await call('/api/folders', 'POST', { name: 'Media' }), 201)).entry;
  const size = 21 * 1024 * 1024;
  const first = new Uint8Array(16 * 1024 * 1024);
  const second = new Uint8Array(5 * 1024 * 1024);
  first.forEach((_, i) => { first[i] = i % 251; });
  second.forEach((_, i) => { second[i] = (i + 17) % 251; });
  const digest = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');

  const session = await json(await call('/api/multipart', 'POST', {
    parentId: folder.id, name: 'shot.mov', mime: 'video/quicktime', size,
  }), 201);
  assert.equal(session.partSize, 16 * 1024 * 1024);
  assert.ok(session.uploadId);
  const p1 = await json(await call(`/api/multipart/${session.uploadId}/parts/1`, 'PUT', first, 'owner@example.com', { 'x-content-sha256': await digest(first) }), 200);
  const p2 = await json(await call(`/api/multipart/${session.uploadId}/parts/2`, 'PUT', second, 'owner@example.com', { 'x-content-sha256': await digest(second) }), 200);
  assert.equal(p1.size, first.byteLength);
  assert.equal(p2.size, second.byteLength);
  const status = await json(await call(`/api/multipart/${session.uploadId}`), 200);
  assert.deepEqual(status.parts.map((part) => part.part_number ?? part.partNumber), [1, 2]);
  assert.deepEqual(status.parts.map((part) => part.sha256), [await digest(first), await digest(second)]);

  const completed = (await json(await call(`/api/multipart/${session.uploadId}/complete`, 'POST', {}), 200)).entry;
  assert.equal(completed.name, 'shot.mov');
  const range = await call(`/api/entries/${completed.id}/download`, 'GET', undefined, 'owner@example.com', { Range: 'bytes=0-31' });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), `bytes 0-31/${size}`);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), first.slice(0, 32));
  const head = await call(`/api/entries/${completed.id}/download`, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(size));
  const etag = head.headers.get('ETag');
  assert.ok(etag);
  assert.equal((await call(`/api/entries/${completed.id}/download`, 'GET', undefined, 'owner@example.com', { 'If-Match': etag })).status, 200);
  assert.equal((await call(`/api/entries/${completed.id}/download`, 'GET', undefined, 'owner@example.com', { 'If-Match': '"stale"' })).status, 412);

  await json(await call(`/api/entries/${folder.id}/access`, 'PUT', { grants: [{ email: 'viewer@example.com', role: 'viewer' }] }), 200);
  assert.equal((await call(`/api/entries/${completed.id}/download`, 'GET', undefined, 'viewer@example.com')).status, 200);
  assert.equal((await call(`/api/multipart/${session.uploadId}` , 'GET', undefined, 'outsider@example.com')).status, 404);
  assert.equal((await call('/api/multipart', 'POST', { parentId: folder.id, name: 'blocked.mov', mime: 'video/quicktime', size: 1 }, 'viewer@example.com')).status, 404);
  assert.equal((await call('/api/multipart', 'POST', { parentId: folder.id, name: 'over-quota.mov', mime: 'video/quicktime', size: 64 * 1024 * 1024 })).status, 413);
  // Exercise the real Python client over HTTP against the built Worker, using
  // only synthetic JWTs. No deployed authentication bypass is introduced.
  const temporary = mkdtempSync(join(tmpdir(), 'cabinet-media-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const tokenPath = join(temporary, 'token');
  writeFileSync(tokenPath, tokens.get('owner@example.com'), { mode: 0o600 });
  let origin, interrupt = true;
  const dataReads = [];
  const bridge = createServer(async (request, response) => {
    try {
      if (request.method === 'PUT' && request.url.endsWith('/parts/2') && interrupt) {
        interrupt = false;
        request.resume();
        response.writeHead(503); response.end('simulated network interruption'); return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.method === 'GET' && request.url.includes('/download')) dataReads.push(request.headers.range);
      const upstream = await mf.dispatchFetch(origin + request.url, {
        method: request.method, headers: request.headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.concat(chunks),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } catch { response.writeHead(500); response.end('test bridge failed'); }
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => bridge.close(resolve)));
  origin = `http://127.0.0.1:${bridge.address().port}`;
  const code = `
import sys, pathlib
from desktop.client import CloudCabinetClient, CabinetError, BLOCK_SIZE
url, token, temporary, folder = sys.argv[1:]
root = pathlib.Path(temporary)
source = root / 'python-source.mov'
with source.open('wb') as f: f.truncate(21 * 1024 * 1024)
c = CloudCabinetClient(url, token, root / 'cache', allow_http_localhost=True)
try:
    c.upload_multipart(source, folder)
    raise AssertionError('expected interruption')
except CabinetError as e:
    assert '503' in str(e) or 'connection failed' in str(e), str(e)
result = c.upload_multipart(source, folder)
e = result['entry']
assert e['size'] == source.stat().st_size
assert c.read_range(e['id'], BLOCK_SIZE - 3, 10, e['currentVersion']) == bytes(10)
assert c.read_range(e['id'], BLOCK_SIZE - 3, 10, e['currentVersion']) == bytes(10)
assert c.entries(folder)
print('Python upload resume and block-cache integration passed')
`;
  const child = spawn(process.env.PYTHON3 || 'python3', ['-c', code, origin, tokenPath, temporary, folder.id], { cwd: root });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(exitCode, 0, output);
  assert.deepEqual(dataReads, ['bytes=0-4194303', 'bytes=4194304-8388607']);

});
