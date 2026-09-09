#!/usr/bin/env python3
"""Create and verify a portable Cloud Cabinet backup.

The command uses only the standard library.  It invokes wrangler for D1 and
the AWS CLI for R2's S3-compatible endpoint.  Credentials are read by those
CLIs from their normal environment/configuration, never from argv.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

FORMAT = "cloud-cabinet-backup-1"
HEX64 = set("0123456789abcdef")


class BackupError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_key(key: str) -> str:
    if not isinstance(key, str) or not key or "\\" in key:
        raise BackupError(f"unsafe object key: {key!r}")
    if any(part in ("", ".", "..") for part in key.split("/")):
        raise BackupError(f"unsafe object key: {key!r}")
    p = PurePosixPath(key)
    if p.is_absolute() or any(part in ("", ".", "..") for part in p.parts):
        raise BackupError(f"unsafe object key: {key!r}")
    return "/".join(p.parts)


def under(root: Path, key: str) -> Path:
    safe = safe_key(key)
    target = (root / Path(*safe.split("/"))).resolve()
    base = root.resolve()
    current = base
    for part in safe.split("/")[:-1]:
        current /= part
        if current.is_symlink():
            raise BackupError(f"symlink in object path: {key!r}")
    if target != base and base not in target.parents:
        raise BackupError(f"object escapes backup directory: {key!r}")
    return target


def run(command: list[str]) -> None:
    try:
        subprocess.run(command, check=True)
    except FileNotFoundError as exc:
        raise BackupError(f"required executable not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        raise BackupError(f"command failed ({exc.returncode}): {' '.join(command)}") from exc


def load_versions(sql_path: Path) -> list[dict]:
    if sql_path.is_symlink():
        raise BackupError("D1 export must not be a symlink")
    with tempfile.TemporaryDirectory(prefix="cloud-cabinet-sql-") as temp:
        db = Path(temp) / "export.sqlite"
        try:
            conn = sqlite3.connect(db)
            if hasattr(conn, "enable_load_extension"):
                conn.enable_load_extension(False)
            allowed_pragmas = {"foreign_keys", "user_version", "recursive_triggers", "quick_check", "foreign_key_check", "defer_foreign_keys", "table_info"}
            def authorizer(action, arg1, arg2, db_name, source):
                if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_FUNCTION):
                    return sqlite3.SQLITE_DENY
                if action == sqlite3.SQLITE_PRAGMA and arg1 not in allowed_pragmas:
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            conn.set_authorizer(authorizer)
            conn.executescript(sql_path.read_text(encoding="utf-8"))
            if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise BackupError("D1 export failed quick_check")
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT id, object_key, size, sha256 FROM versions ORDER BY id").fetchall()
            version_ids = {row[0] for row in conn.execute("SELECT id FROM versions")}
            if conn.execute("PRAGMA foreign_key_check").fetchone():
                raise BackupError("D1 export contains broken foreign-key references")
            version_columns = {row[1] for row in conn.execute("PRAGMA table_info(versions)")}
            if "entry_id" in version_columns and conn.execute("SELECT 1 FROM entries e JOIN versions v ON v.id=e.current_version WHERE v.entry_id!=e.id LIMIT 1").fetchone():
                raise BackupError("Current version belongs to another file")
            for entry_id, current_version in conn.execute("SELECT id, current_version FROM entries WHERE current_version IS NOT NULL"):
                if current_version not in version_ids:
                    raise BackupError(f"entry {entry_id} points to missing current version {current_version}")
            conn.close()
        except sqlite3.Error as exc:
            raise BackupError(f"D1 export is not readable SQLite SQL: {exc}") from exc
    result = []
    for row in rows:
        key = safe_key(row["object_key"])
        expected = row["sha256"]
        if expected is not None and (len(expected) != 64 or set(expected.lower()) - HEX64):
            raise BackupError(f"invalid sha256 for version {row['id']}")
        result.append({"id": row["id"], "objectKey": key, "size": row["size"], "sha256": expected})
    return result


def object_records(content: Path) -> list[dict]:
    records = []
    for path in sorted(p for p in content.rglob("*") if p.is_file()):
        if path.is_symlink() or any((content / parent).is_symlink() for parent in path.relative_to(content).parents):
            raise BackupError(f"symlink in object tree: {path}")
        key = path.relative_to(content).as_posix()
        safe_key(key)
        records.append({"objectKey": key, "size": path.stat().st_size, "sha256": sha256_file(path)})
    return records


def verify_snapshot(snapshot: Path) -> dict:
    manifest_path = snapshot / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise BackupError(f"missing {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BackupError(f"invalid manifest: {exc}") from exc
    if manifest.get("format") != FORMAT:
        raise BackupError("unsupported backup format")
    sql_path = snapshot / "d1.sql"
    if sql_path.is_symlink() or not sql_path.is_file() or sha256_file(sql_path) != manifest.get("d1Sha256"):
        raise BackupError("D1 export is missing or its hash does not match manifest")
    versions = load_versions(sql_path)
    objects = {r["objectKey"]: r for r in manifest.get("objects", [])}
    if len(objects) != len(manifest.get("objects", [])):
        raise BackupError("manifest contains duplicate object keys")
    actual = {r["objectKey"]: r for r in object_records(snapshot / "objects")}
    if actual != objects:
        missing = sorted(set(objects) - set(actual))
        extra = sorted(set(actual) - set(objects))
        raise BackupError(f"object inventory mismatch (missing={missing[:3]}, extra={extra[:3]})")
    for version in versions:
        record = actual.get(version["objectKey"])
        if record is None:
            raise BackupError(f"missing object for D1 version {version['id']}: {version['objectKey']}")
        if version["size"] != record["size"]:
            raise BackupError(f"size mismatch for D1 version {version['id']}")
        if version["sha256"] and version["sha256"].lower() != record["sha256"]:
            raise BackupError(f"hash mismatch for D1 version {version['id']}")
    return manifest


def update_cache(snapshot: Path, cache: Path) -> None:
    """Add verified objects to an append-only, content-addressed local cache."""
    cache = cache.expanduser().resolve()
    cache.mkdir(parents=True, exist_ok=True)
    os.chmod(cache, 0o700)
    index_path = cache / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    for record in manifest["objects"]:
        digest = record["sha256"]
        blob = cache / digest
        source = snapshot / "objects" / Path(*safe_key(record["objectKey"]).split("/"))
        if blob.exists():
            if sha256_file(blob) != digest or blob.stat().st_size != record["size"]:
                raise BackupError(f"cache corruption for {digest}")
        else:
            temp = cache / f".{digest}.tmp"
            shutil.copyfile(source, temp)
            os.chmod(temp, 0o600)
            if sha256_file(temp) != digest:
                temp.unlink()
                raise BackupError(f"cache verification failed for {record['objectKey']}")
            temp.replace(blob)
        index[record["objectKey"]] = {"sha256": digest, "size": record["size"]}
    index_path.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(index_path, 0o600)


def create_backup(args: argparse.Namespace) -> Path:
    destination = Path(args.destination).expanduser().resolve()
    if destination.exists() and any(destination.iterdir()):
        raise BackupError(f"destination must be new or empty: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    os.chmod(destination, 0o700)
    staging = Path(tempfile.mkdtemp(prefix="cloud-cabinet-backup-", dir=destination.parent))
    try:
        os.chmod(staging, 0o700)
        sql = staging / "d1.sql"
        if args.d1_sql:
            if Path(args.d1_sql).is_symlink():
                raise BackupError("D1 export must not be a symlink")
            shutil.copyfile(args.d1_sql, sql)
        else:
            if not getattr(args, "writes_paused", False):
                raise BackupError("remote backup requires --writes-paused acknowledgement")
            wrangler = os.environ.get("CLOUD_CABINET_WRANGLER", "wrangler")
            config = os.environ.get("CLOUD_CABINET_WRANGLER_CONFIG", "wrangler.jsonc")
            run([wrangler, "d1", "export", args.binding, "--remote", "--config", config, "--output", str(sql)])
        content = staging / "objects"
        content.mkdir(mode=0o700)
        if args.r2_source:
            source = Path(args.r2_source).expanduser().resolve()
            if not source.is_dir():
                raise BackupError(f"R2 source is not a directory: {source}")
            for item in source.rglob("*"):
                if item.is_file():
                    if item.is_symlink() or any((source / parent).is_symlink() for parent in item.relative_to(source).parents):
                        raise BackupError(f"symlink in R2 source: {item}")
                    key = item.relative_to(source).as_posix()
                    target = under(content, key)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(item, target)
        else:
            endpoint = os.environ.get("CLOUD_CABINET_R2_ENDPOINT")
            bucket = os.environ.get("CLOUD_CABINET_R2_BUCKET")
            if not endpoint or not bucket:
                raise BackupError("set CLOUD_CABINET_R2_ENDPOINT and CLOUD_CABINET_R2_BUCKET, or use --r2-source")
            aws = os.environ.get("CLOUD_CABINET_AWS", "aws")
            command = [aws, "s3", "cp", f"s3://{bucket}", str(content), "--recursive", "--endpoint-url", endpoint]
            profile = os.environ.get("CLOUD_CABINET_AWS_PROFILE") or os.environ.get("AWS_PROFILE")
            if profile:
                command.extend(["--profile", profile])
            run(command)
        versions = load_versions(sql)
        objects = object_records(content)
        manifest = {
            "format": FORMAT,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "d1Sha256": sha256_file(sql),
            "versions": versions,
            "objects": objects,
            "consistency": "Pause writes for the D1 export and R2 copy; resume only after verification.",
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(staging / "d1.sql", 0o600)
        os.chmod(staging / "manifest.json", 0o600)
        verify_snapshot(staging)
        if getattr(args, "cache", None):
            update_cache(staging, Path(args.cache))
        for path in sorted(staging.rglob("*")):
            if path.is_dir():
                os.chmod(path, 0o700)
            else:
                os.chmod(path, 0o600)
        if any(destination.iterdir()):
            raise BackupError("destination changed while backup was running")
        for item in staging.iterdir():
            shutil.move(str(item), str(destination / item.name))
        staging.rmdir()
        return destination
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", help="new or empty local snapshot directory")
    parser.add_argument("--binding", default="DB", help="wrangler D1 binding (default: DB)")
    parser.add_argument("--d1-sql", type=Path, help="use an existing wrangler D1 SQL export")
    parser.add_argument("--r2-source", type=Path, help="offline R2 object directory, useful for testing")
    parser.add_argument("--cache", type=Path, help="append verified bytes to a private content-addressed local cache")
    parser.add_argument("--verify", action="store_true", help="verify an existing snapshot instead of creating one")
    parser.add_argument("--writes-paused", action="store_true", help="acknowledge maintenance mode before a remote backup")
    args = parser.parse_args()
    try:
        result = verify_snapshot(Path(args.destination)) if args.verify else create_backup(args)
        print(f"verified backup: {len(result['objects'])} objects" if args.verify else f"verified backup: {result}")
        return 0
    except BackupError as exc:
        print(f"backup error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
