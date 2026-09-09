ALTER TABLE uploads ADD COLUMN multipart_id TEXT;
CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number >= 1),
  size INTEGER NOT NULL CHECK(size >= 0),
  etag TEXT,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(upload_id, part_number)
);
CREATE INDEX IF NOT EXISTS upload_parts_upload_idx ON upload_parts(upload_id, part_number);
