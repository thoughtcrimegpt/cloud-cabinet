CREATE TABLE storage_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO storage_lock(id) VALUES(1);
ALTER TABLE uploads ADD COLUMN source TEXT;
CREATE UNIQUE INDEX uploads_source ON uploads(source) WHERE source IS NOT NULL;
ALTER TABLE versions ADD COLUMN sha256 TEXT;
CREATE TABLE file_events (id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
