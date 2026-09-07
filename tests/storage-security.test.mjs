import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStorage, importFile } from '../src/storage.ts';
import {
  makeEnv,
  owner,
  editor,
  viewer,
  outsider,
  callStorage,
  jsonResponse,
  createFolder,
  upload,
} from './helpers.mjs';

async function grant(env, entryId, grants, actor = owner) {
  const response = await callStorage(
    handleStorage,
    env,
    actor,
    `/api/entries/${entryId}/access`,
    { method: 'PUT', json: { grants } },
  );
  assert.equal(response.status, 200);
}

test('outsiders cannot enumerate, download, inspect versions, rename, trash, or create at root', async () => {
  const env = makeEnv();
  const file = await upload(
    handleStorage,
    env,
    owner,
    'secret.txt',
    new TextEncoder().encode('secret'),
  );
  assert.equal(file.status, 200);
  const id = file.body.entry.id;
  const rootListing = await jsonResponse(
    await callStorage(handleStorage, env, outsider, '/api/entries'),
  );
  assert.equal(rootListing.status, 200);
  assert.deepEqual(rootListing.body.entries, []);
  for (const request of [
    [`/api/entries/${id}/download`, {}],
    [`/api/entries/${id}/versions`, {}],
    [`/api/entries/${id}`, { method: 'PATCH', json: { name: 'stolen.txt' } }],
    [`/api/entries/${id}/trash`, { method: 'POST', json: {} }],
  ])
    assert.equal(
      (await callStorage(handleStorage, env, outsider, request[0], request[1]))
        .status,
      404,
    );
  assert.equal(
    (
      await callStorage(handleStorage, env, editor, '/api/folders', {
        method: 'POST',
        json: { name: 'editor-root', parentId: 'root' },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await callStorage(handleStorage, env, editor, '/api/uploads', {
        method: 'POST',
        json: {
          name: 'editor-root.txt',
          parentId: 'root',
          size: 1,
          mime: 'text/plain',
        },
      })
    ).status,
    404,
  );
});

test('nested grants inherit, while a direct grant can revoke access below it', async () => {
  const env = makeEnv();
  const folder = await createFolder(handleStorage, env, owner, 'shared');
  const nested = await createFolder(
    handleStorage,
    env,
    owner,
    'nested',
    folder.id,
  );
  const file = await upload(
    handleStorage,
    env,
    owner,
    'note.txt',
    new TextEncoder().encode('hello'),
    nested.id,
  );
  const id = file.body.entry.id;
  await grant(env, folder.id, [{ email: editor.email, role: 'editor' }]);
  const listing = await jsonResponse(
    await callStorage(
      handleStorage,
      env,
      editor,
      `/api/entries?parent=${nested.id}`,
    ),
  );
  assert.equal(listing.status, 200);
  assert.equal(listing.body.entries[0].id, id);
  assert.equal(listing.body.entries[0].role, 'editor');
  assert.equal(
    (
      await callStorage(
        handleStorage,
        env,
        editor,
        `/api/entries/${id}/download`,
      )
    ).status,
    200,
  );
  await grant(env, nested.id, []);
  assert.equal(
    (
      await callStorage(
        handleStorage,
        env,
        editor,
        `/api/entries?parent=${nested.id}`,
      )
    ).status,
    200,
    'empty direct grants inherit',
  );
  await grant(env, nested.id, [{ email: viewer.email, role: 'viewer' }]);
  assert.equal(
    (
      await callStorage(
        handleStorage,
        env,
        editor,
        `/api/entries?parent=${nested.id}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await callStorage(
        handleStorage,
        env,
        editor,
        `/api/entries/${id}/download`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await callStorage(
        handleStorage,
        env,
        viewer,
        `/api/entries/${id}/download`,
      )
    ).status,
    200,
  );
});

test('revoked editor cannot finalize a previously reserved upload', async () => {
  const env = makeEnv();
  const folder = await createFolder(handleStorage, env, owner, 'drop');
  await grant(env, folder.id, [{ email: editor.email, role: 'editor' }]);
  const bytes = new TextEncoder().encode('pending');
  const prep = await jsonResponse(
    await callStorage(handleStorage, env, editor, '/api/uploads', {
      method: 'POST',
      json: {
        name: 'pending.txt',
        parentId: folder.id,
        size: bytes.byteLength,
        mime: 'text/plain',
      },
    }),
  );
  assert.equal(prep.status, 201);
  await grant(env, folder.id, []);
  const done = await jsonResponse(
    await callStorage(handleStorage, env, editor, prep.body.url, {
      method: 'PUT',
      body: bytes,
      headers: { 'content-length': String(bytes.byteLength) },
    }),
  );
  assert.equal(done.status, 404);
});

test('rejects malformed sizes and enforces reservations against quota, including concurrent prepares', async () => {
  const env = makeEnv({ maxStorage: 10, maxUpload: 10 });
  for (const size of [-1, 1.5, Number.NaN]) {
    const response = await callStorage(
      handleStorage,
      env,
      owner,
      '/api/uploads',
      {
        method: 'POST',
        json: { name: `bad-${String(size)}.txt`, size, mime: 'text/plain' },
      },
    );
    assert.equal(response.status, 400);
  }
  const oversized = await callStorage(
    handleStorage,
    env,
    owner,
    '/api/uploads',
    {
      method: 'POST',
      json: { name: 'too-big.txt', size: 11, mime: 'text/plain' },
    },
  );
  assert.ok([400, 413].includes(oversized.status));
  const first = await callStorage(handleStorage, env, owner, '/api/uploads', {
    method: 'POST',
    json: { name: 'a.txt', size: 6, mime: 'text/plain' },
  });
  assert.equal(first.status, 201);
  const second = await callStorage(handleStorage, env, owner, '/api/uploads', {
    method: 'POST',
    json: { name: 'b.txt', size: 5, mime: 'text/plain' },
  });
  assert.equal(second.status, 413);
  const concurrent = await Promise.all([
    callStorage(handleStorage, env, owner, '/api/uploads', {
      method: 'POST',
      json: { name: 'c.txt', size: 4, mime: 'text/plain' },
    }),
    callStorage(handleStorage, env, owner, '/api/uploads', {
      method: 'POST',
      json: { name: 'd.txt', size: 4, mime: 'text/plain' },
    }),
  ]);
  assert.equal(concurrent.filter((r) => r.status === 201).length, 1);
});

test('versions remain immutable and restore adds a pointer version without losing originals', async () => {
  const env = makeEnv();
  const first = await upload(
    handleStorage,
    env,
    owner,
    'history.txt',
    new TextEncoder().encode('one'),
  );
  const id = first.body.entry.id,
    v1 = first.body.entry.currentVersion;
  const second = await upload(
    handleStorage,
    env,
    owner,
    'history.txt',
    new TextEncoder().encode('two'),
    'root',
    { entryId: id, baseVersion: v1 },
  );
  assert.equal(second.status, 200);
  const v2 = second.body.entry.currentVersion;
  const restored = await jsonResponse(
    await callStorage(
      handleStorage,
      env,
      owner,
      `/api/entries/${id}/versions/${v1}/restore`,
      { method: 'POST', json: { baseVersion: v2 } },
    ),
  );
  assert.equal(restored.status, 200);
  const v3 = restored.body.entry.currentVersion;
  assert.notEqual(v3, v1);
  assert.equal(restored.body.entry.size, 3);
  const usage = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(
    usage.body.usedBytes,
    6,
    'restore points at old object without charging bytes twice',
  );
  const versions = await jsonResponse(
    await callStorage(handleStorage, env, owner, `/api/entries/${id}/versions`),
  );
  assert.equal(versions.body.versions.length, 3);
  assert.equal(
    await new Response(
      (
        await callStorage(
          handleStorage,
          env,
          owner,
          `/api/entries/${id}/download?version=${v1}`,
        )
      ).body,
    ).text(),
    'one',
  );
  assert.equal(
    await new Response(
      (
        await callStorage(
          handleStorage,
          env,
          owner,
          `/api/entries/${id}/download`,
        )
      ).body,
    ).text(),
    'one',
  );
  const conflict = await jsonResponse(
    await callStorage(
      handleStorage,
      env,
      owner,
      `/api/entries/${id}/versions/${v2}/restore`,
      { method: 'POST', json: { baseVersion: v2 } },
    ),
  );
  assert.equal(conflict.status, 409);
  const current = await jsonResponse(
    await callStorage(handleStorage, env, owner, `/api/entries/${id}/versions`),
  );
  assert.equal(
    current.body.versions.length,
    3,
    'failed CAS restore does not add a version',
  );
});

test('usedBytes counts unique stored objects and pending reservations', async () => {
  const env = makeEnv();
  const first = await upload(
    handleStorage,
    env,
    owner,
    'bytes.txt',
    new TextEncoder().encode('12345'),
  );
  const id = first.body.entry.id,
    v1 = first.body.entry.currentVersion;
  await upload(
    handleStorage,
    env,
    owner,
    'bytes.txt',
    new TextEncoder().encode('1234567'),
    'root',
    { entryId: id, baseVersion: v1 },
  );
  const listing = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(listing.body.usedBytes, 12);
  const pending = await callStorage(handleStorage, env, owner, '/api/uploads', {
    method: 'POST',
    json: { name: 'wait.txt', size: 2, mime: 'text/plain' },
  });
  assert.equal(pending.status, 201);
  const after = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(after.body.usedBytes, 14);
});

test('viewer cannot rename or restore, and owners cannot create invalid folder moves', async () => {
  const env = makeEnv();
  const a = await createFolder(handleStorage, env, owner, 'a');
  const b = await createFolder(handleStorage, env, owner, 'b', a.id);
  const file = await upload(
    handleStorage,
    env,
    owner,
    'doc.txt',
    new TextEncoder().encode('x'),
    b.id,
  );
  await grant(env, a.id, [{ email: viewer.email, role: 'viewer' }]);
  assert.equal(
    (
      await callStorage(
        handleStorage,
        env,
        viewer,
        `/api/entries/${file.body.entry.id}`,
        { method: 'PATCH', json: { name: 'renamed' } },
      )
    ).status,
    404,
  );
  await callStorage(
    handleStorage,
    env,
    owner,
    `/api/entries/${file.body.entry.id}/trash`,
    { method: 'POST', json: {} },
  );
  assert.equal(
    (
      await callStorage(
        handleStorage,
        env,
        viewer,
        `/api/entries/${file.body.entry.id}/restore`,
        { method: 'POST', json: {} },
      )
    ).status,
    404,
  );
  for (const [parentId, expected] of [
    [a.id, 409],
    [file.body.entry.id, 404],
    ['missing-folder', 404],
  ]) {
    assert.equal(
      (
        await callStorage(handleStorage, env, owner, `/api/entries/${a.id}`, {
          method: 'PATCH',
          json: { parentId },
        })
      ).status,
      expected,
    );
  }
});

test('trashed entries are retained for the owner trash view and hidden from normal listings', async () => {
  const env = makeEnv();
  const file = await upload(
    handleStorage,
    env,
    owner,
    'retained.txt',
    new TextEncoder().encode('keep'),
  );
  const id = file.body.entry.id;
  await callStorage(handleStorage, env, owner, `/api/entries/${id}/trash`, {
    method: 'POST',
    json: {},
  });
  const normal = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(
    normal.body.entries.some((entry) => entry.id === id),
    false,
  );
  const trash = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries?trash=1'),
  );
  assert.equal(trash.status, 200);
  assert.equal(
    trash.body.entries.some((entry) => entry.id === id),
    true,
  );
  assert.equal(
    (await callStorage(handleStorage, env, outsider, '/api/entries?trash=1'))
      .status,
    404,
  );
});

test('duplicate pending names do not leak or double count quota', async () => {
  const env = makeEnv({ maxStorage: 10, maxUpload: 10 });
  const first = await callStorage(handleStorage, env, owner, '/api/uploads', {
    method: 'POST',
    json: { name: 'same.txt', size: 8, mime: 'text/plain' },
  });
  assert.equal(first.status, 201);
  const duplicate = await callStorage(
    handleStorage,
    env,
    owner,
    '/api/uploads',
    { method: 'POST', json: { name: 'same.txt', size: 8, mime: 'text/plain' } },
  );
  assert.ok([400, 404, 409, 413].includes(duplicate.status));
  const listing = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(listing.body.usedBytes, 8);
});

test('imports are source-idempotent, distinguish separate mails, and reserve quota safely', async () => {
  const env = makeEnv({ maxStorage: 6, maxUpload: 10 });
  const data = new TextEncoder().encode('abc');
  const same1 = await importFile(
    env,
    owner,
    null,
    'first.txt',
    'text/plain',
    data,
    'gmail://mail/one/0',
  );
  const same2 = await importFile(
    env,
    owner,
    null,
    'different-name.txt',
    'text/plain',
    data,
    'gmail://mail/one/0',
  );
  assert.equal(same2.entryId, same1.entryId);
  const separate = await importFile(
    env,
    owner,
    null,
    'second.txt',
    'text/plain',
    data,
    'gmail://mail/two/0',
  );
  assert.notEqual(separate.entryId, same1.entryId);
  const concurrent = await Promise.allSettled([
    importFile(
      env,
      owner,
      null,
      'third.txt',
      'text/plain',
      data,
      'gmail://mail/three/0',
    ),
    importFile(
      env,
      owner,
      null,
      'fourth.txt',
      'text/plain',
      data,
      'gmail://mail/four/0',
    ),
  ]);
  assert.equal(
    concurrent.filter((result) => result.status === 'fulfilled').length,
    0,
  );
  const listing = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(listing.body.usedBytes, 6);
});

test('rejects the 101st folder before committing it', async () => {
  const env = makeEnv();
  let parentId = 'root';
  for (let depth = 1; depth <= 100; depth++)
    parentId = (
      await createFolder(handleStorage, env, owner, `depth-${depth}`, parentId)
    ).id;
  const rejected = await callStorage(
    handleStorage,
    env,
    owner,
    '/api/folders',
    { method: 'POST', json: { name: 'depth-101', parentId } },
  );
  assert.ok([404, 409].includes(rejected.status));
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM entries WHERE name=?',
  )
    .bind('depth-101')
    .first();
  assert.equal(Number(row.n), 0);
});

test('rejects upload at parent depth 100 without changing pending quota', async () => {
  const env = makeEnv({ maxStorage: 1000 });
  let parentId = 'root';
  for (let depth = 1; depth <= 100; depth++)
    parentId = (
      await createFolder(
        handleStorage,
        env,
        owner,
        `upload-depth-${depth}`,
        parentId,
      )
    ).id;
  const before = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  const rejected = await callStorage(
    handleStorage,
    env,
    owner,
    '/api/uploads',
    {
      method: 'POST',
      json: { name: 'too-deep.txt', parentId, size: 10, mime: 'text/plain' },
    },
  );
  assert.ok([404, 409].includes(rejected.status));
  const after = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(after.body.usedBytes, before.body.usedBytes);
  assert.equal(
    Number(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM uploads WHERE name=?')
          .bind('too-deep.txt')
          .first()
      ).n,
    ),
    0,
  );
});

test('rejects moving a folder with a child beyond depth 100 and leaves its parent unchanged', async () => {
  const env = makeEnv();
  const source = await createFolder(handleStorage, env, owner, 'movable');
  await createFolder(handleStorage, env, owner, 'child', source.id);
  let target = 'root';
  for (let depth = 1; depth <= 99; depth++)
    target = (
      await createFolder(
        handleStorage,
        env,
        owner,
        `move-depth-${depth}`,
        target,
      )
    ).id;
  const rejected = await callStorage(
    handleStorage,
    env,
    owner,
    `/api/entries/${source.id}`,
    { method: 'PATCH', json: { parentId: target } },
  );
  assert.ok([404, 409].includes(rejected.status));
  assert.equal(
    (
      await env.DB.prepare('SELECT parent_id FROM entries WHERE id=?')
        .bind(source.id)
        .first()
    ).parent_id,
    null,
  );
});

test('listing 100 files uses bounded database reads', async () => {
  const env = makeEnv();
  for (let i = 0; i < 100; i++)
    await upload(
      handleStorage,
      env,
      owner,
      `listed-${i}.txt`,
      new Uint8Array([i]),
    );
  env.DB.resetQueryCount();
  const listing = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(listing.status, 200);
  assert.equal(listing.body.entries.length, 100);
  assert.ok(
    env.DB.queryCount <= 10,
    `listing made ${env.DB.queryCount} database reads`,
  );
});

test('a stolen write lease aborts the commit and an upload retry preserves old content', async () => {
  const env = makeEnv();
  const original = await upload(
    handleStorage,
    env,
    owner,
    'guarded.txt',
    new TextEncoder().encode('old'),
  );
  const file = original.body.entry;
  const prepared = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/uploads', {
      method: 'POST',
      json: {
        entryId: file.id,
        baseVersion: file.currentVersion,
        name: file.name,
        size: 3,
        mime: 'text/plain',
      },
    }),
  );
  assert.equal(prepared.status, 201);
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    env.DB.batch = batch;
    await env.DB.prepare(
      'UPDATE storage_lock SET token=?,expires_at=0 WHERE id=1',
    )
      .bind('replacement-lease')
      .run();
    return batch(statements);
  };
  const interrupted = await callStorage(
    handleStorage,
    env,
    owner,
    prepared.body.url,
    { method: 'PUT', body: new TextEncoder().encode('new') },
  );
  assert.equal(interrupted.status, 500);
  assert.equal(
    await (
      await callStorage(
        handleStorage,
        env,
        owner,
        `/api/entries/${file.id}/download`,
      )
    ).text(),
    'old',
  );
  const retried = await callStorage(
    handleStorage,
    env,
    owner,
    prepared.body.url,
    { method: 'PUT', body: new TextEncoder().encode('new') },
  );
  assert.equal(retried.status, 200);
  assert.equal(
    await (
      await callStorage(
        handleStorage,
        env,
        owner,
        `/api/entries/${file.id}/download`,
      )
    ).text(),
    'new',
  );
  assert.equal(
    await (
      await callStorage(
        handleStorage,
        env,
        owner,
        `/api/entries/${file.id}/download?version=${file.currentVersion}`,
      )
    ).text(),
    'old',
  );
});

test('listing pagination reaches every file without duplicates', async () => {
  const env = makeEnv();
  for (let i = 0; i < 205; i++)
    await createFolder(
      handleStorage,
      env,
      owner,
      `Folder ${String(i).padStart(3, '0')}`,
    );
  const first = await jsonResponse(
    await callStorage(handleStorage, env, owner, '/api/entries'),
  );
  assert.equal(first.body.entries.length, 200);
  assert.equal(first.body.nextOffset, 200);
  const next = await jsonResponse(
    await callStorage(
      handleStorage,
      env,
      owner,
      `/api/entries?offset=${first.body.nextOffset}`,
    ),
  );
  assert.equal(next.body.entries.length, 5);
  assert.equal(next.body.nextOffset, null);
  assert.equal(
    new Set([...first.body.entries, ...next.body.entries].map((e) => e.id))
      .size,
    205,
  );
});

test('stale cleanup cannot delete a replacement Gmail import after a reservation expires', async () => {
  const env = makeEnv();
  const put = env.FILES.put.bind(env.FILES);
  let obsoleteKey;
  env.FILES.put = async (key, bytes, options) => {
    obsoleteKey = key;
    await put(key, bytes, options);
    throw new Error('Simulated lost write acknowledgement');
  };
  const bytes = new TextEncoder().encode('keep');
  await assert.rejects(
    importFile(
      env,
      owner,
      null,
      'mail.txt',
      'text/plain',
      bytes,
      'gmail://owner@example.com/retry/0',
    ),
  );
  await env.DB.prepare('UPDATE uploads SET expires_at=?')
    .bind(new Date(0).toISOString())
    .run();
  env.FILES.put = put;
  const replacement = await importFile(
    env,
    owner,
    null,
    'mail.txt',
    'text/plain',
    bytes,
    'gmail://owner@example.com/retry/0',
  );
  const saved = await env.DB.prepare(
    'SELECT object_key FROM versions WHERE entry_id=?',
  )
    .bind(replacement.entryId)
    .first();
  assert.notEqual(saved.object_key, obsoleteKey);
  await env.FILES.delete(obsoleteKey);
  assert.equal(
    await (
      await callStorage(
        handleStorage,
        env,
        owner,
        `/api/entries/${replacement.entryId}/download`,
      )
    ).text(),
    'keep',
  );
});
