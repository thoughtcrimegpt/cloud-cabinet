import type { User } from './auth.ts';
type Role = 'owner' | 'editor' | 'viewer';
export type Entry = {
  id: string;
  parent_id: string | null;
  name: string;
  kind: 'file' | 'folder';
  mime: string;
  current_version: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  trashed: number;
};
type Version = {
  id: string;
  entry_id: string;
  object_key: string;
  size: number;
  mime: string;
  created_at: string;
  created_by: string;
  source: string;
  sha256: string | null;
};
type Grant = { email: string; role: 'editor' | 'viewer' };
type Upload = {
  id: string;
  entry_id: string | null;
  parent_id: string | null;
  name: string;
  size: number;
  mime: string;
  object_key: string;
  base_version: string | null;
  created_by: string;
  source: string | null;
  expires_at: string;
};
const MAX_UPLOAD = 20 * 1024 * 1024;
const now = () => new Date().toISOString();
const root = (id: unknown) =>
  typeof id === 'string' && id !== 'root' && id !== '' ? id : null;
const json = (value: unknown, status = 200) => Response.json(value, { status });
class StorageError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
function deny(): never {
  throw new StorageError('File or folder not found.', 404);
}
function nameOf(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw new StorageError(
      'Use a file name of 1 to 255 characters without slashes or control characters.',
    );
  return value.trim();
}
function mimeOf(value: unknown) {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value) &&
    value.length <= 200
    ? value
    : 'application/octet-stream';
}
function quota(env: Env) {
  const value = Number(env.MAX_STORAGE_BYTES);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new StorageError('Storage quota is not configured correctly.', 503);
  return value;
}
async function readBytes(request: Request, max: number) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && Number(declared) > max)
    throw new StorageError('Request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const deadline = Date.now() + 120000;
  try {
    for (;;) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new StorageError('Upload timed out.', 408)),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      if (result.done) break;
      length += result.value.byteLength;
      if (length > max) throw new StorageError('Request is too large.', 413);
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = JSON.parse(
      new TextDecoder().decode(await readBytes(request, 16384)),
    );
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('Invalid JSON request.');
  }
}
async function row(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM entries WHERE id=?')
    .bind(id)
    .first<Entry>();
}
async function version(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM versions WHERE id=?')
    .bind(id)
    .first<Version>();
}
async function ancestry(env: Env, entry: Entry, allowSelfTrash = false) {
  const chain = (
    await env.DB.prepare(
      'WITH RECURSIVE chain AS (SELECT e.*,0 depth FROM entries e WHERE id=? UNION ALL SELECT e.*,c.depth+1 FROM entries e JOIN chain c ON e.id=c.parent_id WHERE c.depth<100) SELECT * FROM chain ORDER BY depth',
    )
      .bind(entry.id)
      .all<Entry>()
  ).results;
  if (!chain.length || chain.length > 100 || chain.at(-1)?.parent_id) deny();
  const seen = new Set<string>();
  for (const [index, current] of chain.entries()) {
    if (
      seen.has(current.id) ||
      (current.trashed && !(allowSelfTrash && index === 0))
    )
      deny();
    seen.add(current.id);
  }
  return chain;
}
export async function role(
  env: Env,
  entry: Entry,
  user: User,
  allowTrash = false,
): Promise<Role | null> {
  const chain = await ancestry(env, entry, allowTrash);
  if (user.isOwner) return 'owner';
  const grants = (
    await env.DB.prepare(
      'SELECT entry_id,email,role FROM grants WHERE entry_id IN (SELECT value FROM json_each(?))',
    )
      .bind(JSON.stringify(chain.map((e) => e.id)))
      .all<Grant & { entry_id: string }>()
  ).results;
  for (const node of chain) {
    const list = grants.filter((g) => g.entry_id === node.id);
    if (list.length)
      return list.find((g) => g.email === user.email)?.role || null;
  }
  return null;
}
export async function authorized(
  env: Env,
  id: string,
  user: User,
  write = false,
  allowTrash = false,
) {
  const entry = await row(env, id);
  if (!entry || (entry.kind === 'file' && !entry.current_version)) deny();
  const permission = await role(env, entry, user, allowTrash);
  if (!permission || (write && permission === 'viewer')) deny();
  return entry;
}
async function parentAllowed(env: Env, id: string | null, user: User) {
  if (!id) {
    if (!user.isOwner) deny();
    return;
  }
  const entry = await authorized(env, id, user, true);
  if (entry.kind !== 'folder') deny();
  if ((await ancestry(env, entry)).length >= 100)
    throw new StorageError(
      'Folders support at most 100 levels. Choose a shallower destination.',
      409,
    );
}
async function view(env: Env, entry: Entry, user: User, allowTrash = false) {
  const permission = await role(env, entry, user, allowTrash);
  if (!permission) return null;
  const v = entry.current_version
    ? await version(env, entry.current_version)
    : null;
  return entryView(entry, permission, v?.size || 0, v?.mime || entry.mime);
}
function entryView(entry: Entry, permission: Role, size: number, mime: string) {
  return {
    id: entry.id,
    parentId: entry.parent_id,
    name: entry.name,
    kind: entry.kind,
    size,
    mime,
    currentVersion: entry.current_version,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    trashed: !!entry.trashed,
    role: permission,
  };
}
async function used(env: Env) {
  const r = await env.DB.prepare(
    'SELECT COALESCE((SELECT SUM(size) FROM (SELECT object_key,MAX(size) size FROM versions GROUP BY object_key)),0)+(SELECT COALESCE(SUM(size),0) FROM uploads) AS total',
  ).first<{ total: number }>();
  return r?.total || 0;
}
function audit(env: Env, entryId: string, user: User, action: string) {
  return env.DB.prepare(
    'INSERT INTO file_events(id,entry_id,actor,action,created_at) VALUES(?,?,?,?,?)',
  ).bind(crypto.randomUUID(), entryId, user.email, action, now());
}
// The constraint fails inside the same transaction if another writer took the lease.
// A preflight SELECT alone cannot fence a request that stalls before its commit.
async function commit(
  env: Env,
  token: string,
  statements: D1PreparedStatement[],
) {
  return env.DB.batch([
    env.DB.prepare(
      'UPDATE storage_lock SET id=CASE WHEN token=? THEN 1 ELSE 0 END WHERE id=1',
    ).bind(token),
    ...statements,
  ]);
}
async function stillLocked(env: Env, token: string) {
  const lock = await env.DB.prepare(
    'SELECT id FROM storage_lock WHERE id=1 AND token=? AND expires_at>?',
  )
    .bind(token, Date.now())
    .first();
  if (!lock)
    throw new StorageError('The write expired. Retry the operation.', 409);
}
async function cleanup(env: Env, token: string) {
  const expired = (
    await env.DB.prepare(
      'SELECT * FROM uploads WHERE expires_at<? ORDER BY expires_at LIMIT 10',
    )
      .bind(now())
      .all<Upload>()
  ).results;
  for (const upload of expired) {
    const referenced = await env.DB.prepare(
      'SELECT id FROM versions WHERE object_key=? LIMIT 1',
    )
      .bind(upload.object_key)
      .first();
    if (!referenced) await env.FILES.delete(upload.object_key);
    await commit(env, token, [
      env.DB.prepare('DELETE FROM uploads WHERE id=?').bind(upload.id),
      env.DB.prepare(
        "DELETE FROM entries WHERE id=? AND kind='file' AND current_version IS NULL",
      ).bind(upload.id),
    ]);
  }
}
async function locked<T>(
  env: Env,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const token = crypto.randomUUID();
  const acquired = await env.DB.prepare(
    'UPDATE storage_lock SET token=?,expires_at=? WHERE id=1 AND expires_at<? RETURNING id',
  )
    .bind(token, Date.now() + 300000, Date.now())
    .first();
  if (!acquired)
    throw new StorageError(
      'Another file change is in progress. Try again shortly.',
      409,
    );
  try {
    await cleanup(env, token);
    return await fn(token);
  } finally {
    await env.DB.prepare(
      'UPDATE storage_lock SET token=NULL,expires_at=0 WHERE id=1 AND token=?',
    )
      .bind(token)
      .run();
  }
}
async function createFolder(
  request: Request,
  env: Env,
  user: User,
  token: string,
) {
  const data = await body(request),
    name = nameOf(data.name),
    parentId = root(data.parentId);
  await parentAllowed(env, parentId, user);
  await ensureNameFree(env, parentId, name);
  const id = crypto.randomUUID(),
    timestamp = now();
  await stillLocked(env, token);
  await commit(env, token, [
    env.DB.prepare(
      'INSERT INTO entries(id,parent_id,name,kind,mime,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?)',
    ).bind(
      id,
      parentId,
      name,
      'folder',
      'application/x-directory',
      timestamp,
      timestamp,
      user.email,
    ),
    audit(env, id, user, 'create_folder'),
  ]);
  return json({ entry: await view(env, (await row(env, id))!, user) }, 201);
}
async function ensureNameFree(
  env: Env,
  parentId: string | null,
  name: string,
  except?: string,
) {
  const found = await env.DB.prepare(
    'SELECT id FROM entries WHERE parent_id IS ? AND name=? AND id!=?',
  )
    .bind(parentId, name, except || '')
    .first();
  if (found)
    throw new StorageError(
      'That name already exists, including retained trash. Choose a different name.',
      409,
    );
}
async function reserve(
  env: Env,
  user: User,
  data: Record<string, unknown>,
  token: string,
  forcedId?: string,
  source?: string,
) {
  const name = nameOf(data.name),
    size = data.size;
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_UPLOAD
  )
    throw new StorageError('Upload size must be between zero and 20 MiB.');
  let existing: Entry | null = null;
  if ('entryId' in data) {
    if (typeof data.entryId !== 'string') deny();
    existing = await authorized(env, data.entryId, user, true);
    if (existing.kind !== 'file') deny();
    if (data.baseVersion !== existing.current_version)
      throw new StorageError(
        'This file changed. Refresh before uploading another version.',
        409,
      );
  }
  const parentId = existing ? existing.parent_id : root(data.parentId);
  if (!existing) {
    await parentAllowed(env, parentId, user);
    await ensureNameFree(env, parentId, name);
  }
  const id = forcedId || crypto.randomUUID(),
    timestamp = now(),
    mime = mimeOf(data.mime);
  await stillLocked(env, token);
  const statements = [
    env.DB.prepare(
      'INSERT INTO uploads(id,entry_id,parent_id,name,size,mime,object_key,base_version,created_by,created_at,expires_at,source) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COALESCE((SELECT SUM(size) FROM (SELECT object_key,MAX(size) size FROM versions GROUP BY object_key)),0)+(SELECT COALESCE(SUM(size),0) FROM uploads))+?<=?',
    ).bind(
      id,
      existing?.id || null,
      parentId,
      name,
      size,
      mime,
      `objects/${crypto.randomUUID()}`,
      existing?.current_version || null,
      user.email,
      timestamp,
      new Date(Date.now() + 3600000).toISOString(),
      source || null,
      size,
      quota(env),
    ),
  ];
  if (!existing)
    statements.push(
      env.DB.prepare(
        'INSERT INTO entries(id,parent_id,name,kind,mime,created_at,updated_at,created_by) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT id FROM uploads WHERE id=?)',
      ).bind(
        id,
        parentId,
        name,
        'file',
        mime,
        timestamp,
        timestamp,
        user.email,
        id,
      ),
    );
  await commit(env, token, statements);
  const upload = await env.DB.prepare('SELECT * FROM uploads WHERE id=?')
    .bind(id)
    .first<Upload>();
  if (!upload)
    throw new StorageError(
      'Storage quota reached. Retained versions and trash also count.',
      413,
    );
  return upload;
}
async function saveUpload(
  env: Env,
  user: User,
  upload: Upload,
  bytes: Uint8Array,
  token: string,
  importGuard?: () => Promise<void>,
) {
  await importGuard?.();
  if (bytes.length !== upload.size)
    throw new StorageError('Uploaded size does not match the reserved file.');
  if (upload.expires_at < now())
    throw new StorageError('Upload expired. Start a new upload.', 409);
  const id = upload.entry_id || upload.id;
  const entry = await row(env, id);
  if (!entry || entry.trashed) deny();
  if (upload.entry_id) {
    await authorized(env, id, user, true);
    if (entry.current_version !== upload.base_version)
      throw new StorageError(
        'Another version was saved first. Refresh and retry.',
        409,
      );
  } else {
    await parentAllowed(env, entry.parent_id, user);
    if (entry.current_version)
      throw new StorageError('File was already saved.', 409);
  }
  const sha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  const existing = await env.FILES.head(upload.object_key);
  if (existing) {
    if (
      existing.size !== bytes.length ||
      existing.customMetadata?.sha256 !== sha256
    )
      throw new StorageError(
        'Retry content differs from the original upload. Start a new version.',
        409,
      );
  } else {
    await env.FILES.put(upload.object_key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: upload.mime },
      customMetadata: { sha256 },
    });
  }
  const stored = await env.FILES.head(upload.object_key);
  if (
    !stored ||
    stored.size !== bytes.length ||
    stored.customMetadata?.sha256 !== sha256
  )
    throw new StorageError(
      'Cloud storage verification failed. Retry the upload.',
      502,
    );
  await stillLocked(env, token);
  // Recheck access immediately before committing. All app changes use the same write lease.
  if (upload.entry_id) await authorized(env, id, user, true);
  else await parentAllowed(env, entry.parent_id, user);
  const versionId = crypto.randomUUID(),
    timestamp = now();
  await importGuard?.();
  await commit(env, token, [
    env.DB.prepare(
      'INSERT INTO versions(id,entry_id,object_key,size,mime,created_at,created_by,source,sha256) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM entries WHERE id=? AND current_version IS ? AND trashed=0)',
    ).bind(
      versionId,
      id,
      upload.object_key,
      bytes.length,
      upload.mime,
      timestamp,
      user.email,
      upload.source || `upload:${upload.id}`,
      sha256,
      id,
      upload.base_version,
    ),
    env.DB.prepare(
      'UPDATE entries SET current_version=?,mime=?,updated_at=? WHERE id=? AND current_version IS ? AND EXISTS(SELECT 1 FROM versions WHERE id=?)',
    ).bind(
      versionId,
      upload.mime,
      timestamp,
      id,
      upload.base_version,
      versionId,
    ),
    env.DB.prepare(
      'DELETE FROM uploads WHERE id=? AND EXISTS(SELECT 1 FROM versions WHERE id=?)',
    ).bind(upload.id, versionId),
    audit(env, id, user, upload.entry_id ? 'upload_version' : 'upload'),
  ]);
  const committed = await version(env, versionId);
  if (!committed)
    throw new StorageError(
      'The file changed while it was uploading. Refresh and retry.',
      409,
    );
  return { entryId: id, entry: await view(env, (await row(env, id))!, user) };
}
async function finish(
  request: Request,
  env: Env,
  user: User,
  id: string,
  token: string,
) {
  const upload = await env.DB.prepare(
    'SELECT * FROM uploads WHERE id=? AND created_by=?',
  )
    .bind(id, user.email)
    .first<Upload>();
  if (!upload) {
    const done = await env.DB.prepare(
      'SELECT entry_id FROM versions WHERE source=? AND created_by=?',
    )
      .bind(`upload:${id}`, user.email)
      .first<{ entry_id: string }>();
    if (!done) deny();
    const entry = await authorized(env, done.entry_id, user, true);
    await request.body?.cancel();
    return json({ entry: await view(env, entry, user) });
  }
  // Reject revoked access before reading the upload body.
  if (upload.entry_id) await authorized(env, upload.entry_id, user, true);
  else await parentAllowed(env, upload.parent_id, user);
  const saved = await saveUpload(
    env,
    user,
    upload,
    await readBytes(request, MAX_UPLOAD),
    token,
  );
  return json({ entry: saved.entry });
}
export async function importFile(
  env: Env,
  user: User,
  parent: string | null,
  name: string,
  mime: string,
  data: ArrayBuffer | Uint8Array,
  source: string,
  guard?: () => Promise<void>,
): Promise<{ entryId: string }> {
  if (!user.isOwner || !source.startsWith('gmail://')) deny();
  return locked(env, async (token) => {
    await guard?.();
    const prior = await env.DB.prepare(
      'SELECT entry_id FROM versions WHERE source=?',
    )
      .bind(source)
      .first<{ entry_id: string }>();
    if (prior) {
      const existing = await row(env, prior.entry_id);
      if (guard && existing?.parent_id !== root(parent))
        throw new StorageError('This attachment was already filed in another folder. Move the existing file instead.', 409);
      return { entryId: prior.entry_id };
    }
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)),
      ),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const id = `gmail-${digest}`;
    let upload = await env.DB.prepare('SELECT * FROM uploads WHERE source=?')
      .bind(source)
      .first<Upload>();
    if (upload && upload.parent_id !== root(parent))
      throw new StorageError('This attachment upload was reserved for another folder. Retry its original destination, then move the saved file.', 409);
    if (!upload) {
      const parentId = root(parent);
      await parentAllowed(env, parentId, user);
      let safeName = nameOf(name);
      const conflict = await env.DB.prepare(
        'SELECT id FROM entries WHERE parent_id IS ? AND name=?',
      )
        .bind(parentId, safeName)
        .first();
      if (conflict) {
        const dot = safeName.lastIndexOf('.');
        const ext = dot > 0 ? safeName.slice(dot).slice(0, 20) : '';
        safeName = `${safeName.slice(0, dot > 0 ? dot : 210).slice(0, 210)} (${digest.slice(0, 12)})${ext}`;
      }
      upload = await reserve(
        env,
        user,
        { name: safeName, parentId, size: data.byteLength, mime },
        token,
        id,
        source,
      );
    }
    const result = await saveUpload(
      env,
      user,
      upload,
      data instanceof Uint8Array ? data : new Uint8Array(data),
      token,
      guard,
    );
    return { entryId: result.entryId };
  });
}
export { locked as withStorageLock };
export async function permissionMap(
  env: Env,
  ids: string[],
  user: User,
  allowSelfTrash = false,
) {
  if (!ids.length) return new Map<string, Role>();
  const records = (
    await env.DB.prepare(`
    WITH RECURSIVE ancestors(entry_id,id,parent_id,trashed,depth) AS (
      SELECT id,id,parent_id,trashed,0 FROM entries WHERE id IN (SELECT value FROM json_each(?))
      UNION ALL SELECT a.entry_id,e.id,e.parent_id,e.trashed,a.depth+1
      FROM entries e JOIN ancestors a ON e.id=a.parent_id WHERE a.depth<100
    ), grant_depth AS (
      SELECT a.entry_id,MIN(a.depth) depth FROM ancestors a JOIN grants g ON a.id=g.entry_id GROUP BY a.entry_id
    )
    SELECT a.entry_id,MAX(a.depth) deepest,MAX(a.trashed) any_trash,
      MAX(CASE WHEN a.depth>0 THEN a.trashed ELSE 0 END) ancestor_trash,
      SUM(CASE WHEN a.parent_id IS NULL THEN 1 ELSE 0 END) reached_root,
      (SELECT g.role FROM ancestors n JOIN grant_depth d ON d.entry_id=n.entry_id AND d.depth=n.depth
        JOIN grants g ON g.entry_id=n.id WHERE n.entry_id=a.entry_id AND g.email=? LIMIT 1) role
    FROM ancestors a GROUP BY a.entry_id
  `)
      .bind(JSON.stringify([...new Set(ids)]), user.email)
      .all<{
        entry_id: string;
        deepest: number;
        any_trash: number;
        ancestor_trash: number;
        reached_root: number;
        role: 'viewer' | 'editor' | null;
      }>()
  ).results;
  const result = new Map<string, Role>();
  for (const r of records) {
    if (
      r.deepest >= 100 ||
      r.reached_root !== 1 ||
      r.ancestor_trash ||
      (!allowSelfTrash && r.any_trash)
    )
      continue;
    if (user.isOwner) result.set(r.entry_id, 'owner');
    else if (r.role) result.set(r.entry_id, r.role);
  }
  return result;
}
async function list(env: Env, user: User, params: URLSearchParams) {
  const parentId = root(params.get('parent')),
    search = (params.get('q') || '').trim().slice(0, 255),
    trash = params.get('trash') === '1';
  const offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000000)
    throw new StorageError('Invalid page.');
  if (trash && !user.isOwner) deny();
  let parentEntry: Entry | null = null;
  if (parentId && !trash) {
    parentEntry = await authorized(env, parentId, user);
    if (parentEntry.kind !== 'folder') deny();
  }
  const clauses = [
    trash ? 'e.trashed=1' : 'e.trashed=0',
    "(e.kind='folder' OR e.current_version IS NOT NULL)",
  ];
  const args: unknown[] = [];
  if (search) {
    clauses.push('instr(lower(e.name),lower(?))>0');
    args.push(search);
  } else if (!trash && (parentId || user.isOwner)) {
    clauses.push('e.parent_id IS ?');
    args.push(parentId);
  } else if (!trash && !user.isOwner) {
    clauses.push('e.id IN (SELECT entry_id FROM grants WHERE email=?)');
    args.push(user.email);
  }
  // Candidate filtering is bounded; nonowners get their topmost accessible shared entries.
  const candidates = (
    await env.DB.prepare(
      `SELECT e.*,v.size version_size,v.mime version_mime FROM entries e LEFT JOIN versions v ON v.id=e.current_version WHERE ${clauses.join(' AND ')} ORDER BY e.kind DESC,e.name,e.id LIMIT 201 OFFSET ?`,
    )
      .bind(...args, offset)
      .all<
        Entry & { version_size: number | null; version_mime: string | null }
      >()
  ).results;
  const chain = parentEntry ? (await ancestry(env, parentEntry)).reverse() : [];
  const permissions = await permissionMap(
    env,
    [
      ...candidates.map((e) => e.id),
      ...candidates.flatMap((e) => (e.parent_id ? [e.parent_id] : [])),
      ...chain.map((e) => e.id),
    ],
    user,
    trash,
  );
  const entries = [];
  for (const entry of candidates.slice(0, 200)) {
    const permission = permissions.get(entry.id);
    if (!permission) continue;
    if (!user.isOwner && !parentId && !search && entry.parent_id) {
      if (permissions.has(entry.parent_id)) continue;
    }
    entries.push(
      entryView(
        entry,
        permission,
        entry.version_size || 0,
        entry.version_mime || entry.mime,
      ),
    );
  }
  const ancestors = [];
  if (parentEntry) {
    for (const entry of chain) {
      if (permissions.has(entry.id))
        ancestors.push({ id: entry.id, name: entry.name });
    }
  }
  const canCreate =
    !trash &&
    !search &&
    (parentEntry
      ? permissions.has(parentEntry.id) &&
        permissions.get(parentEntry.id) !== 'viewer'
      : user.isOwner);
  return json({
    entries,
    ancestors,
    usedBytes: user.isOwner ? await used(env) : 0,
    limitBytes: user.isOwner ? quota(env) : 0,
    truncated: candidates.length > 200,
    nextOffset: candidates.length > 200 ? offset + 200 : null,
    canCreate,
  });
}
async function patch(
  request: Request,
  env: Env,
  user: User,
  id: string,
  token: string,
) {
  const entry = await authorized(env, id, user, true),
    data = await body(request);
  let parentId = entry.parent_id;
  if ('parentId' in data) {
    if (!user.isOwner) deny();
    if (data.parentId !== null && typeof data.parentId !== 'string')
      throw new StorageError('Invalid destination.');
    parentId = root(data.parentId);
    await parentAllowed(env, parentId, user);
    if (parentId) {
      const chain = await ancestry(env, (await row(env, parentId))!);
      if (chain.some((e) => e.id === id))
        throw new StorageError('A folder cannot be moved inside itself.', 409);
      const subtree = await env.DB.prepare(
        'WITH RECURSIVE descendants(id,depth) AS (SELECT id,1 FROM entries WHERE id=? UNION ALL SELECT e.id,d.depth+1 FROM entries e JOIN descendants d ON e.parent_id=d.id WHERE d.depth<=100) SELECT MAX(depth) depth FROM descendants',
      )
        .bind(id)
        .first<{ depth: number }>();
      if (chain.length + (subtree?.depth || 1) > 100)
        throw new StorageError(
          'This move would exceed the 100-level folder limit.',
          409,
        );
    }
  }
  const name = 'name' in data ? nameOf(data.name) : entry.name;
  await ensureNameFree(env, parentId, name, id);
  await stillLocked(env, token);
  await commit(env, token, [
    env.DB.prepare(
      'UPDATE entries SET name=?,parent_id=?,updated_at=? WHERE id=?',
    ).bind(name, parentId, now(), id),
    audit(env, id, user, 'rename_or_move'),
  ]);
  return json({ entry: await view(env, (await row(env, id))!, user) });
}
async function trashEntry(
  env: Env,
  user: User,
  id: string,
  restore: boolean,
  token: string,
) {
  const entry = await authorized(env, id, user, true, restore);
  if (entry.kind === 'folder' && !user.isOwner) deny();
  if (!restore && entry.kind === 'folder') {
    const any = await env.DB.prepare(
      'SELECT id FROM entries WHERE parent_id=? LIMIT 1',
    )
      .bind(id)
      .first();
    if (any)
      throw new StorageError(
        'Folder must be empty, including retained trash.',
        409,
      );
  }
  await stillLocked(env, token);
  await commit(env, token, [
    env.DB.prepare('UPDATE entries SET trashed=?,updated_at=? WHERE id=?').bind(
      restore ? 0 : 1,
      now(),
      id,
    ),
    audit(env, id, user, restore ? 'restore' : 'trash'),
  ]);
  return json({ entry: await view(env, (await row(env, id))!, user, true) });
}
async function download(
  env: Env,
  user: User,
  id: string,
  versionId: string | null,
) {
  const entry = await authorized(env, id, user, false, user.isOwner);
  if (entry.kind !== 'file') deny();
  const v = await version(env, versionId || entry.current_version!);
  if (!v || v.entry_id !== id) deny();
  const object = await env.FILES.get(v.object_key);
  if (!object)
    throw new StorageError(
      'Stored content is missing. Check your backup.',
      502,
    );
  return new Response(object.body, {
    headers: {
      'Content-Type': mimeOf(v.mime),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
      'Content-Length': String(v.size),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
async function versions(env: Env, user: User, id: string) {
  await authorized(env, id, user, false, user.isOwner);
  const records = (
    await env.DB.prepare(
      'SELECT * FROM versions WHERE entry_id=? ORDER BY created_at DESC,id DESC LIMIT 1000',
    )
      .bind(id)
      .all<Version>()
  ).results;
  return json({
    versions: records.map((v) => ({
      id: v.id,
      entryId: v.entry_id,
      size: v.size,
      mime: v.mime,
      createdAt: v.created_at,
      createdBy: user.isOwner ? v.created_by : undefined,
      source: v.source.startsWith('gmail:')
        ? 'gmail import'
        : v.source.startsWith('restore:')
          ? 'restored version'
          : 'upload',
    })),
  });
}
async function restoreVersion(
  request: Request,
  env: Env,
  user: User,
  id: string,
  versionId: string,
  token: string,
) {
  const entry = await authorized(env, id, user, true),
    data = await body(request);
  const old = await version(env, versionId);
  if (!old || old.entry_id !== id) deny();
  if (data.baseVersion !== entry.current_version)
    throw new StorageError(
      'The current version changed. Refresh and retry.',
      409,
    );
  const stored = await env.FILES.head(old.object_key);
  if (!stored || stored.size !== old.size)
    throw new StorageError('Original content is missing from storage.', 502);
  const idNew = crypto.randomUUID(),
    timestamp = now();
  await stillLocked(env, token);
  await commit(env, token, [
    env.DB.prepare(
      'INSERT INTO versions(id,entry_id,object_key,size,mime,created_at,created_by,source,sha256) VALUES(?,?,?,?,?,?,?,?,?)',
    ).bind(
      idNew,
      id,
      old.object_key,
      old.size,
      old.mime,
      timestamp,
      user.email,
      `restore:${idNew}`,
      old.sha256,
    ),
    env.DB.prepare(
      'UPDATE entries SET current_version=?,mime=?,updated_at=? WHERE id=? AND current_version=?',
    ).bind(idNew, old.mime, timestamp, id, entry.current_version),
    audit(env, id, user, 'restore_version'),
  ]);
  return json({ entry: await view(env, (await row(env, id))!, user) });
}
async function access(
  request: Request,
  env: Env,
  user: User,
  id: string,
  token?: string,
) {
  if (!user.isOwner) deny();
  await authorized(env, id, user);
  if (request.method === 'PUT') {
    const data = await body(request);
    if (!Array.isArray(data.grants) || data.grants.length > 100)
      throw new StorageError('Provide at most 100 grants.');
    const grants: Grant[] = [],
      seen = new Set<string>();
    for (const grant of data.grants) {
      if (
        !grant ||
        typeof grant.email !== 'string' ||
        !/^\S+@[^\s@]+\.[^\s@]+$/.test(grant.email) ||
        grant.email.length > 254 ||
        !['viewer', 'editor'].includes(grant.role)
      )
        throw new StorageError(
          'Each grant needs a valid email and Viewer or Editor role.',
        );
      const email = grant.email.trim().toLowerCase();
      if (seen.has(email))
        throw new StorageError('Each person may appear only once.');
      seen.add(email);
      grants.push({ email, role: grant.role });
    }
    await stillLocked(env, token!);
    await commit(env, token!, [
      env.DB.prepare('DELETE FROM grants WHERE entry_id=?').bind(id),
      ...grants.map((g) =>
        env.DB.prepare(
          'INSERT INTO grants(entry_id,email,role) VALUES(?,?,?)',
        ).bind(id, g.email, g.role),
      ),
      audit(env, id, user, 'change_access'),
    ]);
  }
  const grants = (
    await env.DB.prepare(
      'SELECT email,role FROM grants WHERE entry_id=? ORDER BY email',
    )
      .bind(id)
      .all<Grant>()
  ).results;
  return json({ grants, inherited: grants.length === 0 });
}
async function exportIndex(env: Env, user: User) {
  if (!user.isOwner) deny();
  const entries = (
      await env.DB.prepare(
        'SELECT * FROM entries ORDER BY created_at',
      ).all<Entry>()
    ).results,
    versions = (
      await env.DB.prepare(
        'SELECT * FROM versions ORDER BY created_at',
      ).all<Version>()
    ).results;
  return json({
    format: 'cloud-cabinet-1',
    exportedAt: now(),
    entries: entries.map((e) => ({
      id: e.id,
      parentId: e.parent_id,
      name: e.name,
      kind: e.kind,
      currentVersion: e.current_version,
      trashed: !!e.trashed,
    })),
    versions: versions.map((v) => ({
      id: v.id,
      entryId: v.entry_id,
      objectKey: v.object_key,
      size: v.size,
      mime: v.mime,
      sha256: v.sha256,
      createdAt: v.created_at,
      source: v.source,
    })),
    grants: (await env.DB.prepare('SELECT * FROM grants').all()).results,
    projects: (await env.DB.prepare('SELECT * FROM workflow_projects').all()).results,
    checklists: (await env.DB.prepare('SELECT * FROM workflow_checklists').all()).results,
    evidenceReviews: (await env.DB.prepare('SELECT * FROM workflow_reviews').all()).results,
  });
}
export async function handleStorage(
  request: Request,
  env: Env,
  user: User,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  const dispatch = async (token?: string): Promise<Response | null> => {
    if (path === '/api/entries' && method === 'GET')
      return list(env, user, url.searchParams);
    if (path === '/api/export' && method === 'GET')
      return exportIndex(env, user);
    if (path === '/api/folders' && method === 'POST')
      return createFolder(request, env, user, token!);
    if (path === '/api/uploads' && method === 'POST') {
      const upload = await reserve(env, user, await body(request), token!);
      return json(
        { uploadId: upload.id, url: `/api/uploads/${upload.id}` },
        201,
      );
    }
    const upload = path.match(/^\/api\/uploads\/([^/]+)$/);
    if (upload && method === 'PUT')
      return finish(request, env, user, upload[1], token!);
    const restore = path.match(
      /^\/api\/entries\/([^/]+)\/versions\/([^/]+)\/restore$/,
    );
    if (restore && method === 'POST')
      return restoreVersion(request, env, user, restore[1], restore[2], token!);
    const match = path.match(
      /^\/api\/entries\/([^/]+)(?:\/(download|versions|access|trash|restore))?$/,
    );
    if (!match) return null;
    const [, id, action] = match;
    if (action === 'download' && method === 'GET')
      return download(env, user, id, url.searchParams.get('version'));
    if (action === 'versions' && method === 'GET')
      return versions(env, user, id);
    if (action === 'access' && ['GET', 'PUT'].includes(method))
      return access(request, env, user, id, token);
    if (['trash', 'restore'].includes(action) && method === 'POST')
      return trashEntry(env, user, id, action === 'restore', token!);
    if (!action && method === 'PATCH')
      return patch(request, env, user, id, token!);
    return null;
  };
  try {
    return await (['GET', 'HEAD'].includes(method)
      ? dispatch()
      : locked(env, (token) => dispatch(token)));
  } catch (error) {
    if (error instanceof StorageError)
      return json({ error: error.message }, error.status);
    return json(
      {
        error:
          'The request did not finish. Refresh to check the result before retrying.',
      },
      500,
    );
  }
}
