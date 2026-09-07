import type { User } from './auth.ts';
import { importFile } from './storage.ts';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const encoder = new TextEncoder();
type Connection = { email: string; encrypted_token: string };
type Part = {
  partId?: string;
  filename?: string;
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
};
class PermanentMessageError extends Error {}
function safeFilename(value: string | undefined) {
  const name = (value || 'attachment')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .trim()
    .slice(0, 255);
  return !name || name === '.' || name === '..' ? 'attachment' : name;
}
function safeMime(value: string | undefined) {
  return value && /^[\w.+-]+\/[\w.+-]+$/.test(value)
    ? value
    : 'application/octet-stream';
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function unbase64(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
}
function random() {
  return base64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
function enabled(env: Env) {
  try {
    return (
      !!env.GMAIL_CLIENT_ID &&
      !!env.GMAIL_CLIENT_SECRET &&
      unbase64(env.GMAIL_TOKEN_KEY || '').length === 32
    );
  } catch {
    return false;
  }
}
async function key(env: Env) {
  return crypto.subtle.importKey(
    'raw',
    unbase64(env.GMAIL_TOKEN_KEY || ''),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
async function seal(env: Env, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await key(env),
      encoder.encode(token),
    ),
  );
  return `${base64(iv)}.${base64(ciphertext)}`;
}
async function unseal(env: Env, encrypted: string) {
  const [iv, data] = encrypted.split('.');
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64(iv) },
      await key(env),
      unbase64(data),
    ),
  );
}
async function jsonFetch(
  url: string,
  init: RequestInit = {},
  max = 1024 * 1024,
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      'Google request failed. Reconnect Gmail if the problem continues.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Google returned no data.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new PermanentMessageError(
        'This email is too large to import. Download its attachments from Gmail and upload them here.',
      );
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    all.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
async function accessToken(env: Env, connection: Connection) {
  const token = await jsonFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID || '',
      client_secret: env.GMAIL_CLIENT_SECRET || '',
      refresh_token: await unseal(env, connection.encrypted_token),
      grant_type: 'refresh_token',
    }),
  });
  if (typeof token.access_token !== 'string')
    throw new Error('Reconnect Gmail.');
  return token.access_token as string;
}
function parts(part: Part, path = '0'): { part: Part; path: string }[] {
  const disposition =
    part.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')
      ?.value || '';
  const hasCid = part.headers?.some(
    (h) => h.name.toLowerCase() === 'content-id',
  );
  const own =
    part.filename &&
    !/^inline\b/i.test(disposition) &&
    !(hasCid && !/^attachment\b/i.test(disposition))
      ? [{ part, path }]
      : [];
  return [
    ...own,
    ...(part.parts || []).flatMap((child, i) => parts(child, `${path}.${i}`)),
  ];
}
async function readBody(request: Request) {
  if (Number(request.headers.get('content-length') || 0) > 4096)
    throw new Error('Request too large.');
  const reader = request.body?.getReader();
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
  if (!reader) return {};
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new Error('Request too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
export async function handleGmail(
  request: Request,
  env: Env,
  user: User,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/gmail/')) return null;
  if (!user.isOwner)
    return Response.json(
      { error: 'Only the workspace owner can connect or import Gmail.' },
      { status: 403 },
    );
  const route = url.pathname.slice('/api/gmail/'.length);
  if (route === 'status' && request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT email FROM gmail_connection WHERE owner=?',
    )
      .bind(user.email)
      .first<{ email: string }>();
    return Response.json({
      configured: enabled(env),
      connected: !!row,
      email: row?.email,
    });
  }
  if (route === 'disconnect' && request.method === 'POST') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM gmail_connection WHERE owner=?').bind(
        user.email,
      ),
      env.DB.prepare('DELETE FROM gmail_states WHERE owner=?').bind(user.email),
      env.DB.prepare('DELETE FROM gmail_jobs WHERE owner=?').bind(user.email),
    ]);
    return Response.json({ connected: false });
  }
  if (!enabled(env))
    return Response.json(
      {
        error:
          'Add your own Google OAuth client and encryption key using the Gmail setup guide.',
      },
      { status: 503 },
    );
  const redirect = `${url.origin}/api/gmail/callback`;
  if (route === 'connect' && request.method === 'POST') {
    const state = random(),
      verifier = random();
    const challenge = base64(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', encoder.encode(verifier)),
      ),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    await env.DB.prepare(
      'DELETE FROM gmail_states WHERE expires_at<? OR owner=?',
    )
      .bind(Date.now(), user.email)
      .run();
    await env.DB.prepare(
      'INSERT INTO gmail_states(state,owner,verifier,expires_at) VALUES(?,?,?,?)',
    )
      .bind(state, user.email, verifier, Date.now() + 600000)
      .run();
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID || '',
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return Response.json({ url: auth.toString() });
  }
  if (route === 'callback' && request.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    const stored = await env.DB.prepare(
      'DELETE FROM gmail_states WHERE state=? AND owner=? AND expires_at>? RETURNING verifier',
    )
      .bind(state, user.email, Date.now())
      .first<{ verifier: string }>();
    if (!stored)
      return Response.json(
        { error: 'Connection request expired. Start again from the app.' },
        { status: 400 },
      );
    if (url.searchParams.get('error') || !url.searchParams.get('code'))
      return Response.redirect(`${url.origin}/?gmail=cancelled`, 303);
    try {
      const token = await jsonFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GMAIL_CLIENT_ID || '',
          client_secret: env.GMAIL_CLIENT_SECRET || '',
          redirect_uri: redirect,
          grant_type: 'authorization_code',
          code: url.searchParams.get('code')!,
          code_verifier: stored.verifier,
        }),
      });
      if (
        typeof token.refresh_token !== 'string' ||
        typeof token.access_token !== 'string' ||
        !String(token.scope).split(' ').includes(SCOPE)
      )
        throw new Error('Read-only access was not granted.');
      const profile = await jsonFetch(BASE + 'profile', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (typeof profile.emailAddress !== 'string')
        throw new Error('Google did not identify this mailbox.');
      await env.DB.prepare(
        'INSERT INTO gmail_connection(owner,email,encrypted_token,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET email=excluded.email,encrypted_token=excluded.encrypted_token,updated_at=excluded.updated_at',
      )
        .bind(
          user.email,
          profile.emailAddress.toLowerCase(),
          await seal(env, token.refresh_token),
          new Date().toISOString(),
        )
        .run();
      await env.DB.prepare('DELETE FROM gmail_jobs WHERE owner=?')
        .bind(user.email)
        .run();
      return Response.redirect(`${url.origin}/?gmail=connected`, 303);
    } catch {
      return Response.json(
        {
          error:
            'Gmail connection failed. Check your OAuth setup and try again.',
        },
        { status: 502 },
      );
    }
  }
  if (route === 'import' && request.method === 'POST') {
    let acquired = false;
    let nextPageToken: string | undefined;
    const lease = random();
    try {
      const body = await readBody(request);
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const parentId =
        typeof body.parentId === 'string' ? body.parentId : 'root';
      if (!label || label.length > 100 || /[\u0000-\u001f]/.test(label))
        return Response.json(
          { error: 'Enter the Gmail label to import, such as Cabinet.' },
          { status: 400 },
        );
      const connection = await env.DB.prepare(
        'SELECT email,encrypted_token FROM gmail_connection WHERE owner=?',
      )
        .bind(user.email)
        .first<Connection>();
      if (!connection)
        return Response.json(
          { error: 'Connect Gmail first.' },
          { status: 400 },
        );
      // An active import is exclusive. Folder/label changes begin a fresh scan only after release.
      const now = Date.now();
      const job = await env.DB.prepare(
        `INSERT INTO gmail_jobs(owner,label,parent_id,page_token,lease_until,lease_token,started_at) VALUES(?,?,?,NULL,?,?,?) ON CONFLICT(owner) DO UPDATE SET page_token=CASE WHEN label=excluded.label AND parent_id=excluded.parent_id THEN page_token ELSE NULL END,started_at=CASE WHEN label=excluded.label AND parent_id=excluded.parent_id THEN started_at ELSE excluded.started_at END,label=excluded.label,parent_id=excluded.parent_id,lease_until=excluded.lease_until,lease_token=excluded.lease_token WHERE lease_until<? RETURNING page_token,started_at`,
      )
        .bind(user.email, label, parentId, now + 300000, lease, now, now)
        .first<{ page_token: string | null; started_at: number }>();
      if (!job)
        return Response.json(
          { error: 'An import is already running. Try again shortly.' },
          { status: 409 },
        );
      acquired = true;
      const token = await accessToken(env, connection);
      const headers = { Authorization: `Bearer ${token}` };
      const labels = await jsonFetch(BASE + 'labels', { headers });
      const found = (labels.labels || []).find(
        (l: { name: string; id: string }) => l.name === label,
      );
      if (!found)
        return Response.json(
          {
            error:
              'That label was not found. Create it in Gmail and apply it to the messages you want to import.',
          },
          { status: 400 },
        );
      const listUrl = new URL(BASE + 'messages');
      listUrl.searchParams.set('labelIds', found.id);
      listUrl.searchParams.set('maxResults', '1');
      listUrl.searchParams.set(
        'q',
        `has:attachment before:${Math.ceil(job.started_at / 1000)}`,
      );
      if (job.page_token) listUrl.searchParams.set('pageToken', job.page_token);
      const list = await jsonFetch(listUrl.toString(), { headers });
      nextPageToken = list.nextPageToken;
      const messageId = list.messages?.[0]?.id;
      if (!messageId) {
        await env.DB.prepare(
          'DELETE FROM gmail_jobs WHERE owner=? AND lease_token=?',
        )
          .bind(user.email, lease)
          .run();
        return Response.json({
          imported: 0,
          skipped: 0,
          remaining: false,
          issues: [],
        });
      }
      let message: Record<string, any>;
      try {
        message = await jsonFetch(
          `${BASE}messages/${encodeURIComponent(messageId)}?format=full`,
          { headers },
          13 * 1024 * 1024,
        );
      } catch (error) {
        if (error instanceof PermanentMessageError)
          throw new PermanentMessageError(
            'This message is too large to import.',
          );
        throw error;
      }
      const attachments = parts(message.payload || {});
      if (attachments.length > 200) {
        throw new PermanentMessageError(
          'Message skipped because it has more than 200 attachments.',
        );
      }
      let imported = 0,
        skipped = 0,
        remaining = false;
      const issues: string[] = [];
      for (const { part, path } of attachments) {
        const source = `gmail://${connection.email}/${messageId}/${path}`;
        const exists = await env.DB.prepare(
          'SELECT entry_id FROM gmail_imports WHERE identity=? AND owner=?',
        )
          .bind(source, user.email)
          .first<{ entry_id: string | null }>();
        if (exists?.entry_id) {
          skipped++;
          continue;
        }
        const size = part.body?.size;
        if (
          !Number.isSafeInteger(size) ||
          size! < 0 ||
          size! > 8 * 1024 * 1024
        ) {
          issues.push(
            `${part.filename}: use manual upload (automatic import limit is 8 MiB).`,
          );
          continue;
        }
        if (imported >= 2) {
          remaining = true;
          break;
        }
        let data = part.body?.data;
        if (!data && part.body?.attachmentId) {
          const attachment = await jsonFetch(
            `${BASE}messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
            { headers },
            12 * 1024 * 1024,
          );
          data = attachment.data;
        }
        if (typeof data !== 'string') {
          issues.push(`${part.filename}: attachment content was unavailable.`);
          continue;
        }
        const bytes = unbase64(data);
        if (bytes.length !== size) {
          issues.push(
            `${part.filename}: Google returned an unexpected file size.`,
          );
          continue;
        }
        const file = await importFile(
          env,
          user,
          parentId,
          safeFilename(part.filename),
          safeMime(part.mimeType),
          bytes,
          source,
        );
        await env.DB.prepare(
          'INSERT INTO gmail_imports(identity,owner,entry_id,created_at) VALUES(?,?,?,?) ON CONFLICT(identity) DO UPDATE SET entry_id=excluded.entry_id',
        )
          .bind(source, user.email, file.entryId, new Date().toISOString())
          .run();
        imported++;
      }
      if (!remaining) {
        if (list.nextPageToken) {
          await env.DB.prepare(
            'UPDATE gmail_jobs SET page_token=? WHERE owner=? AND lease_token=?',
          )
            .bind(list.nextPageToken, user.email, lease)
            .run();
          remaining = true;
        } else
          await env.DB.prepare(
            'DELETE FROM gmail_jobs WHERE owner=? AND lease_token=?',
          )
            .bind(user.email, lease)
            .run();
      }
      return Response.json({ imported, skipped, remaining, issues });
    } catch (error) {
      if (error instanceof PermanentMessageError) {
        const next = nextPageToken;
        if (next)
          await env.DB.prepare(
            'UPDATE gmail_jobs SET page_token=? WHERE owner=? AND lease_token=?',
          )
            .bind(next, user.email, lease)
            .run();
        else
          await env.DB.prepare(
            'DELETE FROM gmail_jobs WHERE owner=? AND lease_token=?',
          )
            .bind(user.email, lease)
            .run();
        return Response.json({
          imported: 0,
          skipped: 0,
          remaining: Boolean(next),
          issues: [error.message],
        });
      }
      return Response.json(
        {
          error:
            'Import could not finish. Saved files remain safe. Check the destination and Gmail connection, then retry.',
        },
        { status: 502 },
      );
    } finally {
      if (acquired)
        await env.DB.prepare(
          'UPDATE gmail_jobs SET lease_until=0,lease_token=NULL WHERE owner=? AND lease_token=?',
        )
          .bind(user.email, lease)
          .run();
    }
  }
  return Response.json({ error: 'Not found.' }, { status: 404 });
}
