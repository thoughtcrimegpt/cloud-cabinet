#!/usr/bin/env python3
"""Verify or restore a Cloud Cabinet snapshot into a new offline directory."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import sys

from backup import BackupError, safe_key, verify_snapshot


def restore(snapshot: Path, destination: Path) -> None:
    verify_snapshot(snapshot)
    destination = destination.expanduser().resolve()
    if destination.exists() and any(destination.iterdir()):
        raise BackupError(f"restore destination must be new or empty: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    destination.chmod(0o700)
    shutil.copyfile(snapshot / "d1.sql", destination / "d1.sql")
    shutil.copyfile(snapshot / "manifest.json", destination / "manifest.json")
    objects = destination / "objects"
    objects.mkdir(mode=0o700)
    for source in sorted((snapshot / "objects").rglob("*")):
        if source.is_file():
            key = source.relative_to(snapshot / "objects").as_posix()
            target = destination / "objects" / Path(*safe_key(key).split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o600)
    (destination / "d1.sql").chmod(0o600)
    (destination / "manifest.json").chmod(0o600)
    verify_snapshot(destination)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify", help="verify a snapshot offline")
    verify.add_argument("snapshot", type=Path)
    copy = sub.add_parser("restore", help="copy a verified snapshot to a new offline directory")
    copy.add_argument("snapshot", type=Path)
    copy.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "verify":
            verify_snapshot(args.snapshot)
            print("verified snapshot")
        else:
            restore(args.snapshot, args.destination)
            print(f"restored and verified: {args.destination}")
        return 0
    except BackupError as exc:
        print(f"restore error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
