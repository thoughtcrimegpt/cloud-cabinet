-- Preserve existing mailbox credentials and provenance. Polling starts disabled.
ALTER TABLE gmail_states ADD COLUMN mailbox_id TEXT;
CREATE TABLE gmail_mailboxes (
  mailbox_id TEXT PRIMARY KEY, owner TEXT NOT NULL, email TEXT NOT NULL,
  encrypted_token TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(owner,email)
);
INSERT INTO gmail_mailboxes(mailbox_id,owner,email,encrypted_token,created_at,updated_at)
  SELECT 'legacy-' || owner,owner,email,encrypted_token,updated_at,updated_at FROM gmail_connection;
-- Only one live token store after migration. Old imports remain for deduplication.
DELETE FROM gmail_connection;
CREATE TABLE gmail_label_scopes (
  mailbox_id TEXT NOT NULL REFERENCES gmail_mailboxes(mailbox_id), label TEXT NOT NULL,
  destination_id TEXT NOT NULL, scheduled INTEGER NOT NULL DEFAULT 0 CHECK(scheduled IN(0,1)),
  review_only INTEGER NOT NULL DEFAULT 1 CHECK(review_only IN(0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), revision INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(mailbox_id,label)
);
CREATE TABLE gmail_mailbox_jobs (
  mailbox_id TEXT NOT NULL REFERENCES gmail_mailboxes(mailbox_id), label TEXT NOT NULL,
  parent_id TEXT NOT NULL, page_token TEXT, started_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
  PRIMARY KEY(mailbox_id,label)
);
CREATE TABLE gmail_review_queue (
  review_id TEXT PRIMARY KEY, owner TEXT NOT NULL, mailbox_id TEXT NOT NULL,
  identity TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL, part_path TEXT NOT NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, headers_json TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL, destination_id TEXT, entry_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','filing','filed','dismissed','deferred')),
  version INTEGER NOT NULL DEFAULT 1, lease_until INTEGER NOT NULL DEFAULT 0, lease_token TEXT,
  last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX gmail_review_owner_state ON gmail_review_queue(owner,state,created_at);
CREATE TABLE gmail_review_audit (
  audit_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, owner TEXT NOT NULL,
  action TEXT NOT NULL, version INTEGER NOT NULL, destination_id TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER gmail_audit_identity BEFORE INSERT ON gmail_review_audit
WHEN EXISTS(SELECT 1 FROM gmail_review_audit WHERE audit_id=NEW.audit_id)
BEGIN SELECT RAISE(ABORT,'Review identity already exists'); END;
CREATE TRIGGER gmail_audit_no_update BEFORE UPDATE ON gmail_review_audit
BEGIN SELECT RAISE(ABORT,'Review history is immutable'); END;
CREATE TRIGGER gmail_audit_no_delete BEFORE DELETE ON gmail_review_audit
BEGIN SELECT RAISE(ABORT,'Review history is immutable'); END;
