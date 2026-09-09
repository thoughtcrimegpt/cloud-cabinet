import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStorage } from '../src/storage.ts';
import { makeEnv, owner, editor, outsider, callStorage, jsonResponse, upload } from './helpers.mjs';

const part = 16 * 1024 * 1024;
async function create(env, user = owner, size = part + 3) {
  const r = await jsonResponse(await callStorage(handleStorage, env, user, '/api/multipart', { method: 'POST', json: { name: 'large.bin', size, mime: 'application/octet-stream' } }));
  assert.equal(r.status, 201); return r.body.uploadId;
}
function bytes(n, value = 7) { return new Uint8Array(n).fill(value); }

test('multipart reserves quota and exposes resumable part status', async () => {
  const env = makeEnv({ maxStorage: part + 2 });
  const id = await create(env, owner, part + 1);
  const status = await jsonResponse(await callStorage(handleStorage, env, owner, `/api/multipart/${id}`));
  assert.equal(status.body.parts.length, 0);
  assert.equal(status.body.partSize, part);
  assert.equal((await callStorage(handleStorage, env, owner, '/api/multipart', { method: 'POST', json: { name: 'over.bin', size: 2, mime: 'application/octet-stream' } })).status, 413);
});

test('multipart part retries are checksum idempotent and conflicting bytes reject', async () => {
  const env = makeEnv(); const id = await create(env); const data = bytes(part);
  let r = await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: data }); assert.equal(r.status, 200);
  const first = await r.json();
  r = await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: data }); assert.equal(r.status, 200); assert.equal((await r.json()).sha256, first.sha256);
  r = await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: bytes(part, 8) }); assert.equal(r.status, 409);
});

test('multipart rejects outsiders and revoked editors at part and completion', async () => {
  const env = makeEnv(); const folder = await (await callStorage(handleStorage, env, owner, '/api/folders', { method: 'POST', json: { name: 'drop' } })).json();
  await callStorage(handleStorage, env, owner, `/api/entries/${folder.entry.id}/access`, { method: 'PUT', json: { grants: [{ email: editor.email, role: 'editor' }] } });
  const prep = await jsonResponse(await callStorage(handleStorage, env, editor, '/api/multipart', { method: 'POST', json: { name: 'large.bin', parentId: folder.entry.id, size: part, mime: 'application/octet-stream' } }));
  assert.equal((await callStorage(handleStorage, env, outsider, `/api/multipart/${prep.body.uploadId}`)).status, 404);
  await callStorage(handleStorage, env, owner, `/api/entries/${folder.entry.id}/access`, { method: 'PUT', json: { grants: [] } });
  assert.equal((await callStorage(handleStorage, env, editor, `/api/multipart/${prep.body.uploadId}/parts/1`, { method: 'PUT', body: bytes(part) })).status, 404);
});

test('HEAD and byte ranges preserve authorization and immutable version identity', async () => {
  const env = makeEnv(); const saved = await upload(handleStorage, env, owner, 'small.txt', new TextEncoder().encode('abcdef')); const id = saved.body.entry.id;
  const head = await callStorage(handleStorage, env, owner, `/api/entries/${id}/download`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const range = await callStorage(handleStorage, env, owner, `/api/entries/${id}/download`, { headers: { Range: 'bytes=1-3' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'bcd'); assert.equal(range.headers.get('content-range'), 'bytes 1-3/6');
  const bad = await callStorage(handleStorage, env, owner, `/api/entries/${id}/download`, { headers: { Range: 'bytes=99-' } }); assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), 'bytes */6');
  const full = await callStorage(handleStorage, env, owner, `/api/entries/${id}/download`, { headers: { Range: 'bytes=99-', 'If-Range': '"different"' } }); assert.equal(full.status, 200); assert.equal(await full.text(), 'abcdef');
});


test('multipart completion recovers when R2 succeeds but the database commit fails', async () => {
  const env = makeEnv(); const id = await create(env, owner, 3);
  await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: bytes(3) });
  const batch = env.DB.batch.bind(env.DB); let failed = false;
  env.DB.batch = async statements => {
    if (!failed && statements.some(s => s.sql.startsWith('INSERT INTO versions'))) {
      failed = true; throw new Error('simulated database outage');
    }
    return batch(statements);
  };
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/complete`, { method: 'POST' })).status, 500);
  const retry = await jsonResponse(await callStorage(handleStorage, env, owner, `/api/multipart/${id}/complete`, { method: 'POST' }));
  assert.equal(retry.status, 200);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM versions').get().n, 1);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/complete`, { method: 'POST' })).status, 200);
  assert.equal((await jsonResponse(await callStorage(handleStorage, env, owner, `/api/multipart/${id}`))).body.completed, true);
});

test('part hash is reserved before R2 so ambiguous retries cannot change content', async () => {
  const env = makeEnv(); const id = await create(env, owner, 3);
  const resume = env.FILES.resumeMultipartUpload.bind(env.FILES); let fail = true;
  env.FILES.resumeMultipartUpload = (...args) => {
    const mp = resume(...args); const original = mp.uploadPart;
    mp.uploadPart = async (...args) => { const result = await original(...args); if (fail) { fail = false; throw Error('lost response'); } return result; };
    return mp;
  };
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: bytes(3) })).status, 500);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: bytes(3, 9) })).status, 409);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: bytes(3) })).status, 200);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/complete`, { method: 'POST' })).status, 200);
});

test('incorrect final part size, extra parts, incomplete finalization and legacy bypass reject', async () => {
  const env = makeEnv(); const id = await create(env, owner, 3);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: bytes(2) })).status, 400);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/2`, { method: 'PUT', body: bytes(3) })).status, 400);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/uploads/${id}`, { method: 'PUT', body: bytes(3) })).status, 409);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}/complete`, { method: 'POST' })).status, 409);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM versions').get().n, 0);
});

test('expired multipart cleanup aborts R2 and releases its entire reservation', async () => {
  const env = makeEnv({ maxStorage: 3 }); const id = await create(env, owner, 3);
  await callStorage(handleStorage, env, owner, `/api/multipart/${id}/parts/1`, { method: 'PUT', body: bytes(3) });
  env.DB.db.prepare("UPDATE uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  assert.equal((await callStorage(handleStorage, env, owner, `/api/multipart/${id}`)).status, 410);
  await create(env, owner, 3);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) n FROM uploads').get().n, 1);
  assert.equal([...env.FILES.multipart.values()][0].aborted, true);
});

test('HEAD never opens R2 body and ignores Range, empty-file ranges are unsatisfiable', async () => {
  const env = makeEnv(); const saved = await upload(handleStorage, env, owner, 'empty', new Uint8Array());
  const url = `/api/entries/${saved.body.entry.id}/download`;
  env.FILES.get = async () => { throw Error('HEAD must not call get'); };
  assert.equal((await callStorage(handleStorage, env, owner, url, { method: 'HEAD', headers: { Range: 'bytes=0-' } })).status, 200);
  for (const Range of ['bytes=-1', 'bytes=0-', 'bytes=0-0']) {
    const response = await callStorage(handleStorage, env, owner, url, { headers: { Range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */0');
  }
});
