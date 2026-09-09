# Portable backups and offline restore

Cloud Cabinet has no maintainer recovery service. A complete backup contains the remote D1 SQL export and every object in the private R2 bucket. Keep the snapshot private because D1 can contain sharing rules, settings, and an encrypted Gmail token.

Pause writes before exporting. Set the Worker variable `MAINTENANCE_MODE` to the string `true` in your Cloudflare dashboard, wait for active jobs to finish, run the backup, then set it back to `false`. Reads, listing, and downloads remain available while maintenance mode is enabled. This produces a consistent D1 and R2 pair without giving the backup tool application credentials.

The tools require Python 3.10+ and use only the standard library. The default remote command uses the installed `wrangler` and `aws` CLIs. Configure CLI credentials using their normal secure configuration, never command-line secrets:

```sh
export CLOUD_CABINET_R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
export CLOUD_CABINET_R2_BUCKET="cloud-cabinet-files"
# Optional: export CLOUD_CABINET_AWS_PROFILE="cabinet-backup"
python3 scripts/backup.py /private/backups/cloud-cabinet-2026-09-09 --writes-paused
```

Remote backups require `--writes-paused` as an explicit acknowledgement. Keep maintenance mode enabled for the complete export and copy, and wait at least 10 minutes for the Gmail lease window to clear before starting. Add `--cache /private/backups/cloud-cabinet-cache` to keep an append-only, owner-only content-addressed extra copy. Each verified object is stored once by SHA-256, with an index mapping object keys to cached bytes. A corrupt cache entry stops the run. The cache is not used to skip cloud downloads, and each dated snapshot still copies the complete bucket.

The command runs `wrangler d1 export DB --remote --config wrangler.jsonc --output ...` and `aws s3 cp s3://BUCKET ... --recursive --endpoint-url ENDPOINT`. Override the executable or config with `CLOUD_CABINET_WRANGLER`, `CLOUD_CABINET_AWS`, and `CLOUD_CABINET_WRANGLER_CONFIG`. Use `--binding NAME` for a different D1 binding. The destination must be new or empty, and is created with owner-only permissions. The snapshot is written through a private staging directory, then verified before it is moved into place. Existing files are never overwritten.

For a customer supplied export or an offline test fixture, use `--d1-sql EXPORT.sql --r2-source OBJECT_DIRECTORY`. This is also the recovery path when the customer intentionally exports data through another approved S3 client.

Verification never contacts Cloudflare:

```sh
python3 scripts/backup.py /private/backups/cloud-cabinet-2026-09-09 --verify
python3 scripts/restore.py verify /private/backups/cloud-cabinet-2026-09-09
python3 scripts/restore.py restore /private/backups/cloud-cabinet-2026-09-09 /private/recovery/cloud-cabinet-test
```

Verification checks the manifest and D1 SQL hash, every R2 object’s size and SHA-256, every D1 `versions` row, and every object path. Missing objects, changed bytes, invalid hashes, duplicate entries, and absolute or `..` paths fail closed. Restore copies the SQL, manifest, and object tree into a new or empty directory and verifies the copy again. It does not apply SQL to a live D1 or upload to a live R2 bucket, so test recovery in a separate customer installation after reviewing the result.

The manifest records all bucket objects, including unindexed objects. An indexed version with a null legacy `sha256` is still checked for size; current releases write SHA-256 hashes and therefore receive full content verification. The backup is resumable at the operational level by rerunning into a new snapshot and retaining older snapshots. Do not reuse a partially written directory.
