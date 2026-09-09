import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

class Prepared {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  first() {
    return Promise.resolve(this.db.prepare(this.sql).get(...this.args) ?? null);
  }
  all() {
    return Promise.resolve({
      results: this.db.prepare(this.sql).all(...this.args),
      success: true,
    });
  }
  run() {
    return Promise.resolve(this.db.prepare(this.sql).run(...this.args));
  }
}

export class MemoryD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.queryCount = 0;
  }
  prepare(sql) {
    this.queryCount += 1;
    return new Prepared(this.db, sql);
  }
  resetQueryCount() {
    this.queryCount = 0;
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const result = statements.map((s) => {
        const statement = this.db.prepare(s.sql);
        if (/\bRETURNING\b/i.test(s.sql))
          return { results: statement.all(...s.args), success: true };
        statement.run(...s.args);
        return { results: [], success: true };
      });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  exec(sql) {
    this.db.exec(sql);
  }
}

export class MemoryR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value, options = {}) {
    let bytes;
    if (value instanceof Uint8Array) bytes = new Uint8Array(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key))
      return null;
    this.objects.set(key, {
      bytes,
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
    return { size: bytes.byteLength, customMetadata: options.customMetadata };
  }
  async head(key) {
    const object = this.objects.get(key);
    return object
      ? {
          size: object.bytes.byteLength,
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
        }
      : null;
  }
  async delete(key) {
    this.objects.delete(key);
  }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Response(object.bytes).body,
      httpMetadata: object.httpMetadata,
    };
  }
}

export function makeEnv(options = {}) {
  const DB = new MemoryD1();
  for (const file of readdirSync(join(import.meta.dirname, '..', 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
    DB.exec(readFileSync(join(import.meta.dirname, '..', 'migrations', file), 'utf8'));
  }
  return {
    DB,
    FILES: new MemoryR2(),
    OWNER_EMAIL: 'owner@example.com',
    MAX_STORAGE_BYTES: String(options.maxStorage ?? 10_000_000_000),
    MAX_UPLOAD_BYTES: String(options.maxUpload ?? 20 * 1024 * 1024),
  };
}

export const owner = { email: 'owner@example.com', isOwner: true };
export const editor = { email: 'editor@example.com', isOwner: false };
export const viewer = { email: 'viewer@example.com', isOwner: false };
export const outsider = { email: 'outsider@example.com', isOwner: false };

export async function callStorage(
  handleStorage,
  env,
  user,
  path,
  { method = 'GET', json, body, headers = {} } = {},
) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) init.body = body;
  return handleStorage(
    new Request(`https://cabinet.test${path}`, init),
    env,
    user,
  );
}

export async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

export async function createFolder(
  handleStorage,
  env,
  user,
  name,
  parentId = 'root',
) {
  const result = await callStorage(handleStorage, env, user, '/api/folders', {
    method: 'POST',
    json: { name, parentId },
  });
  const parsed = await jsonResponse(result);
  if (parsed.status !== 201)
    throw new Error(`folder creation failed: ${JSON.stringify(parsed)}`);
  return parsed.body.entry;
}

export async function upload(
  handleStorage,
  env,
  user,
  name,
  bytes,
  parentId = 'root',
  extra = {},
) {
  const prep = await callStorage(handleStorage, env, user, '/api/uploads', {
    method: 'POST',
    json: {
      name,
      parentId,
      size: bytes.byteLength,
      mime: 'text/plain',
      ...extra,
    },
  });
  const p = await jsonResponse(prep);
  if (p.status !== 201) return p;
  const done = await callStorage(handleStorage, env, user, p.body.url, {
    method: 'PUT',
    body: bytes,
    headers: { 'content-length': String(bytes.byteLength) },
  });
  return jsonResponse(done);
}
