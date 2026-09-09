from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from backup import BackupError, create_backup, verify_snapshot
from backup import load_versions
from restore import restore


def make_sql(path: Path, key: str, data: bytes, digest: str | None = None) -> None:
    digest = digest or __import__("hashlib").sha256(data).hexdigest()
    path.write_text(
        "CREATE TABLE entries (id TEXT, current_version TEXT);\n"
        "CREATE TABLE versions (id TEXT, object_key TEXT, size INTEGER, sha256 TEXT);\n"
        f"INSERT INTO versions VALUES ('v1','{key}',{len(data)},'{digest}');\n",
        encoding="utf-8",
    )


class BackupTests(unittest.TestCase):
  def test_backup_and_restore_offline(self):
    with __import__("tempfile").TemporaryDirectory() as raw:
      tmp_path = Path(raw)
      sql = tmp_path / "d1.sql"
      source = tmp_path / "r2"
      source.mkdir()
      (source / "nested").mkdir()
      (source / "nested" / "file.txt").write_bytes(b"hello")
      make_sql(sql, "nested/file.txt", b"hello")
      snapshot = tmp_path / "snapshot"
      create_backup(type("Args", (), {"destination": str(snapshot), "d1_sql": sql, "r2_source": source, "binding": "DB"})())
      self.assertEqual(verify_snapshot(snapshot)["format"], "cloud-cabinet-backup-1")
      restored = tmp_path / "restored"
      restore(snapshot, restored)
      self.assertEqual((restored / "objects/nested/file.txt").read_bytes(), b"hello")


  def test_corrupt_object_is_rejected(self):
    with __import__("tempfile").TemporaryDirectory() as raw:
      tmp_path = Path(raw)
      sql = tmp_path / "d1.sql"
      source = tmp_path / "r2"
      source.mkdir()
      (source / "x").write_bytes(b"good")
      make_sql(sql, "x", b"good")
      snapshot = tmp_path / "snapshot"
      create_backup(type("Args", (), {"destination": str(snapshot), "d1_sql": sql, "r2_source": source, "binding": "DB"})())
      (snapshot / "objects/x").write_bytes(b"bad")
      with self.assertRaisesRegex(BackupError, "object inventory mismatch"):
        verify_snapshot(snapshot)


  def test_missing_current_version_is_rejected(self):
    with __import__("tempfile").TemporaryDirectory() as raw:
      tmp_path = Path(raw)
      sql = tmp_path / "d1.sql"
      source = tmp_path / "r2"
      source.mkdir()
      make_sql(sql, "missing", b"gone")
      with self.assertRaisesRegex(BackupError, "missing object"):
        create_backup(type("Args", (), {"destination": str(tmp_path / "snapshot"), "d1_sql": sql, "r2_source": source, "binding": "DB"})())


  def test_path_traversal_rejected(self):
    with __import__("tempfile").TemporaryDirectory() as raw:
      tmp_path = Path(raw)
      sql = tmp_path / "d1.sql"
      source = tmp_path / "r2"
      source.mkdir()
      (source / "x").write_bytes(b"x")
      make_sql(sql, "../outside", b"x")
      with self.assertRaisesRegex(BackupError, "unsafe object key"):
        create_backup(type("Args", (), {"destination": str(tmp_path / "snapshot"), "d1_sql": sql, "r2_source": source, "binding": "DB"})())


  def test_sql_attach_is_rejected(self):
    with __import__("tempfile").TemporaryDirectory() as raw:
      sql = Path(raw) / "bad.sql"
      sql.write_text("ATTACH DATABASE '/tmp/escape.sqlite' AS x;\n", encoding="utf-8")
      with self.assertRaisesRegex(Exception, "not readable|not authorized"):
        load_versions(sql)


if __name__ == "__main__":
  unittest.main()
