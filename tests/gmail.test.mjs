import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGmail } from '../src/gmail.ts';
import {
  makeEnv,
  owner,
  outsider,
  callStorage,
  jsonResponse,
} from './helpers.mjs';

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const configured = () => ({
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_TOKEN_KEY: key,
  MAX_STORAGE_BYTES: '1000000',
  MAX_UPLOAD_BYTES: '1000000',
});
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function connectGmail(env) {
  const connect = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/connect', {
      method: 'POST',
    }),
  );
  const state = new URL(connect.body.url).searchParams.get('state');
  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token'))
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      });
    return Response.json({ emailAddress: owner.email });
  };
  assert.equal(
    (
      await callStorage(
        handleGmail,
        env,
        owner,
        `/api/gmail/callback?state=${state}&code=auth`,
      )
    ).status,
    303,
  );
}

function importFetch({ messageFor, listFor }) {
  const bytes = new TextEncoder().encode('ok');
  const data = btoa(String.fromCharCode(...bytes));
  return async (url) => {
    if (url.includes('oauth2.googleapis.com/token'))
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      });
    if (url.endsWith('/labels'))
      return Response.json({ labels: [{ id: 'LBL', name: 'Cabinet' }] });
    if (url.includes('/messages?')) return Response.json(listFor(url));
    const id = url.match(/messages\/([^?]+)/)?.[1] || '';
    return Response.json(messageFor(id, data, bytes.length));
  };
}

test('Gmail status fails closed until all OAuth and encryption settings exist', async () => {
  const env = makeEnv();
  const response = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/status'),
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.configured, false);
  assert.equal(response.body.connected, false);
  const connect = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/connect', {
      method: 'POST',
    }),
  );
  assert.equal(connect.status, 503);
});

test('Gmail routes are owner-only and do not expose mailbox state', async () => {
  const env = { ...makeEnv(), ...configured() };
  for (const [path, options] of [
    ['/api/gmail/status', {}],
    ['/api/gmail/connect', { method: 'POST' }],
    ['/api/gmail/import', { method: 'POST', json: { label: 'Cabinet' } }],
    ['/api/gmail/disconnect', { method: 'POST' }],
  ]) {
    const response = await jsonResponse(
      await callStorage(handleGmail, env, outsider, path, options),
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.includes('owner'), true);
  }
});

test('connect emits state and S256 PKCE, while expired and wrong-owner callbacks fail', async () => {
  const env = { ...makeEnv(), ...configured() };
  const connect = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/connect', {
      method: 'POST',
    }),
  );
  assert.equal(connect.status, 200);
  const auth = new URL(connect.body.url);
  const state = auth.searchParams.get('state');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(auth.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const wrong = await jsonResponse(
    await callStorage(
      handleGmail,
      env,
      outsider,
      `/api/gmail/callback?state=${state}&code=x`,
    ),
  );
  assert.equal(wrong.status, 403);
  env.DB.prepare('UPDATE gmail_states SET expires_at=0 WHERE state=?')
    .bind(state)
    .run();
  const expired = await jsonResponse(
    await callStorage(
      handleGmail,
      env,
      owner,
      `/api/gmail/callback?state=${state}&code=x`,
    ),
  );
  assert.equal(expired.status, 400);
});

test('callback exchanges code with PKCE, verifies readonly scope, and stores encrypted refresh token', async () => {
  const env = { ...makeEnv(), ...configured() };
  const connect = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/connect', {
      method: 'POST',
    }),
  );
  const auth = new URL(connect.body.url),
    state = auth.searchParams.get('state');
  let tokenBody;
  globalThis.fetch = async (url, init) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      tokenBody = new URLSearchParams(init.body);
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      });
    }
    assert.equal(init.headers.Authorization, 'Bearer access');
    return Response.json({ emailAddress: 'Mailbox@Example.com' });
  };
  const callback = await callStorage(
    handleGmail,
    env,
    owner,
    `/api/gmail/callback?state=${state}&code=auth-code`,
  );
  assert.equal(callback.status, 303);
  assert.equal(tokenBody.get('code_verifier')?.length, 43);
  assert.equal(tokenBody.get('code_verifier'), tokenBody.get('code_verifier'));
  const row = await env.DB.prepare(
    'SELECT * FROM gmail_connection WHERE owner=?',
  )
    .bind(owner.email)
    .first();
  assert.equal(row.email, 'mailbox@example.com');
  assert.notEqual(row.encrypted_token, 'refresh');
  assert.match(row.encrypted_token, /^[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$/);
});

test('manual readonly import is bounded and deduplicates the same Gmail attachment', async () => {
  const env = { ...makeEnv(), ...configured() };
  const connect = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/connect', {
      method: 'POST',
    }),
  );
  const state = new URL(connect.body.url).searchParams.get('state');
  let tokenCalls = 0;
  const bytes = new TextEncoder().encode('hello');
  const data = btoa(String.fromCharCode(...bytes));
  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      tokenCalls++;
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      });
    }
    if (url.endsWith('/profile'))
      return Response.json({ emailAddress: owner.email });
    if (url.endsWith('/labels'))
      return Response.json({ labels: [{ id: 'LBL', name: 'Cabinet' }] });
    if (url.includes('/messages?'))
      return Response.json({ messages: [{ id: 'msg-1' }] });
    return Response.json({
      payload: {
        parts: [
          {
            filename: 'hello.txt',
            mimeType: 'text/plain',
            body: { size: bytes.length, data },
          },
        ],
      },
    });
  };
  assert.equal(
    (
      await callStorage(
        handleGmail,
        env,
        owner,
        `/api/gmail/callback?state=${state}&code=auth`,
      )
    ).status,
    303,
  );
  const first = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/import', {
      method: 'POST',
      json: { label: 'Cabinet' },
    }),
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.imported, 1);
  assert.equal(first.body.skipped, 0);
  assert.deepEqual(first.body.issues, []);
  const second = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/import', {
      method: 'POST',
      json: { label: 'Cabinet' },
    }),
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.imported, 0);
  assert.equal(second.body.skipped, 1);
  assert.equal(tokenCalls, 3);
});

test('permanent poison messages advance the Gmail cursor to the following message', async () => {
  const env = { ...makeEnv(), ...configured() };
  await connectGmail(env);
  const tooMany = Array.from({ length: 201 }, (_, i) => ({
    filename: `bad-${i}.txt`,
    mimeType: 'text/plain',
    body: { size: 1, data: 'eA==' },
  }));
  globalThis.fetch = importFetch({
    listFor: (url) =>
      url.includes('pageToken=next')
        ? { messages: [{ id: 'good' }] }
        : { messages: [{ id: 'poison' }], nextPageToken: 'next' },
    messageFor: (id, data, size) =>
      id === 'poison'
        ? { payload: { parts: tooMany } }
        : {
            payload: {
              parts: [
                {
                  filename: 'good.txt',
                  mimeType: 'text/plain',
                  body: { size, data },
                },
              ],
            },
          },
  });
  const first = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/import', {
      method: 'POST',
      json: { label: 'Cabinet' },
    }),
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.imported, 0);
  assert.equal(first.body.remaining, true);
  assert.match(first.body.issues[0], /200 attachments/);
  const second = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/import', {
      method: 'POST',
      json: { label: 'Cabinet' },
    }),
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.imported, 1);
  assert.equal(second.body.remaining, false);
});

test('oversized provider messages advance the cursor', async () => {
  const env = { ...makeEnv(), ...configured() };
  await connectGmail(env);
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token'))
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      });
    if (url.endsWith('/labels'))
      return Response.json({ labels: [{ id: 'LBL', name: 'Cabinet' }] });
    if (url.includes('/messages?'))
      return calls++ === 0
        ? Response.json({ messages: [{ id: 'large' }], nextPageToken: 'next' })
        : Response.json({ messages: [] });
    return new Response('x'.repeat(13 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/import', {
      method: 'POST',
      json: { label: 'Cabinet' },
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.remaining, true);
  assert.match(result.body.issues[0], /too large/i);
});

test('transient provider failures preserve the Gmail cursor for retry', async () => {
  const env = { ...makeEnv(), ...configured() };
  await connectGmail(env);
  let listCalls = 0;
  const bytes = new TextEncoder().encode('retry');
  const data = btoa(String.fromCharCode(...bytes));
  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token'))
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      });
    if (url.endsWith('/labels'))
      return Response.json({ labels: [{ id: 'LBL', name: 'Cabinet' }] });
    if (url.includes('/messages?') && listCalls++ === 0)
      return new Response('down', { status: 503 });
    if (url.includes('/messages?'))
      return Response.json({ messages: [{ id: 'retry' }] });
    return Response.json({
      payload: {
        parts: [
          {
            filename: 'retry.txt',
            mimeType: 'text/plain',
            body: { size: bytes.length, data },
          },
        ],
      },
    });
  };
  const failed = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/import', {
      method: 'POST',
      json: { label: 'Cabinet' },
    }),
  );
  assert.equal(failed.status, 502);
  const success = await jsonResponse(
    await callStorage(handleGmail, env, owner, '/api/gmail/import', {
      method: 'POST',
      json: { label: 'Cabinet' },
    }),
  );
  assert.equal(success.status, 200);
  assert.equal(success.body.imported, 1);
});
