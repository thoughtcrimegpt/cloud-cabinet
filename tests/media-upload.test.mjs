import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadMedia } from '../web/media-upload.ts';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});
function fixture() {
  const memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: key => memory.delete(key),
  }});
  const parts = new Map();
  let completes = 0, reserves = 0, aborted = false, fail = true;
  const api = async (path, data, method) => {
    if (path === '/api/multipart') {
      reserves++;
      return { uploadId: 'test-session', partSize: 16 * 1024 ** 2 };
    }
    if (method === 'DELETE') { aborted = true; return {}; }
    if (path.endsWith('/complete')) { completes++; return {}; }
    return { uploadId: 'test-session', partSize: 16 * 1024 ** 2, parts: [...parts.values()] };
  };
  globalThis.fetch = async (path, init) => {
    const partNumber = Number(path.split('/').pop());
    if (partNumber === 2 && fail) { fail = false; throw new Error('Interrupted'); }
    const data = await init.body.arrayBuffer();
    const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
    parts.set(partNumber, { partNumber, size: data.byteLength, sha256 });
    return Response.json({});
  };
  return { api, parts, memory, stats: () => ({ completes, reserves, aborted }) };
}
test('large browser upload resumes retained parts and commits only after all bytes arrive', async () => {
  const f = fixture();
  const file = new File([new Uint8Array(21 * 1024 ** 2)], 'clip.mov', { lastModified: 1 });
  const send = () => uploadMedia(file, { parentId: 'root', name: file.name }, f.api, () => {}, 'editor@example.com');
  await assert.rejects(send, /Interrupted/);
  assert.equal(f.parts.size, 1);
  assert.equal(f.stats().completes, 0);
  const retained = f.parts.get(1);
  await send();
  assert.equal(f.parts.get(1), retained, 'retained part was not transferred again');
  assert.equal(f.parts.size, 2);
  assert.equal(f.stats().reserves, 1);
  assert.equal(f.stats().completes, 1);
  assert.equal(f.memory.size, 0);
});
test('same filename, size and timestamp cannot splice different bytes into a resumed upload', async () => {
  const f = fixture();
  const bytes = new Uint8Array(21 * 1024 ** 2);
  const target = { parentId: 'root', name: 'clip.mov' };
  await assert.rejects(() => uploadMedia(new File([bytes], target.name, { lastModified: 1 }), target, f.api, () => {}, 'editor'));
  bytes[0] = 99;
  await assert.rejects(() => uploadMedia(new File([bytes], target.name, { lastModified: 1 }), target, f.api, () => {}, 'editor'), /differs/);
  assert.equal(f.stats().aborted, true);
  assert.equal(f.stats().completes, 0);
});
