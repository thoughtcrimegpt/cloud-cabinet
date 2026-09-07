CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  company_name TEXT NOT NULL DEFAULT 'Cloud Cabinet',
  accent_color TEXT NOT NULL DEFAULT '#1430a3',
  custom_css TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO app_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS gmail_connection (
  owner TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gmail_states (
  state TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gmail_imports (
  identity TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  entry_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gmail_jobs (
  owner TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  page_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  started_at INTEGER NOT NULL
);
