PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file','folder')),
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  current_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  trashed INTEGER NOT NULL DEFAULT 0 CHECK (trashed IN (0,1)),
  UNIQUE(parent_id, name)
);
CREATE INDEX IF NOT EXISTS entries_parent_idx ON entries(parent_id, trashed, name);
CREATE INDEX IF NOT EXISTS entries_name_idx ON entries(name);
CREATE UNIQUE INDEX IF NOT EXISTS entries_root_name_idx ON entries(name) WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id),
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  mime TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload'
);
CREATE INDEX IF NOT EXISTS versions_entry_idx ON versions(entry_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS versions_source_idx ON versions(source);

CREATE TABLE IF NOT EXISTS grants (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  PRIMARY KEY(entry_id, email)
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  entry_id TEXT REFERENCES entries(id),
  parent_id TEXT,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  mime TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  base_version TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_expiry_idx ON uploads(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uploads_parent_name_idx ON uploads(parent_id, name) WHERE entry_id IS NULL;
