# Media drive engineering preview

This branch adds the first media-drive vertical slice to Cloud Cabinet. It is
not a production LucidLink replacement or a studio security certification.

## What works in this milestone

- Browser and folder uploads use resumable 16 MiB parts for files over 20 MiB,
  with a 100 GiB limit per file. Reselect the same file after an interruption.
  Previously uploaded parts are checked against the selected file before reuse.
- The total application quota remains configurable independently of file size.
  A terabyte library requires increasing `MAX_STORAGE_BYTES`; the default is
  still 10 GB. Reservations, versions and trash count against the quota.
- Authenticated GET downloads support single byte ranges. HEAD returns metadata
  without fetching the body. Immutable versions and ETags keep reads consistent.
- An optional Python/FUSE desktop client presents source files as a read-only
  filesystem. It fetches only the required 4 MiB blocks and keeps a bounded
  private local cache. See [desktop setup](../desktop/README.md).
- Every client read reauthorizes with the server, including cache hits. This
  intentionally trades latency for checking current application permissions.

Save project files, renders and application scratch data on a local writable
volume during this pilot. Upload revisions explicitly. The mounted source
volume rejects writes. Do not use it as a render-farm output volume.

## Storage and integrity

Original small uploads retain their whole-file SHA-256 behavior. Multipart
parts are hashed individually and conflicting part retries are rejected.
Multipart versions have a null whole-file `sha256`: do not interpret the R2
multipart ETag as a SHA-256 or claim that a full-file digest was verified.
Backup tools still compute and verify hashes on exported bytes. D1 and R2
must be backed up together, with writes paused as documented in
[backup instructions](backup.md).

The first server implementation serializes writes using the existing global
storage lease. It prioritizes correctness over aggregate studio throughput.
Expiry cleanup runs during subsequent storage mutations. Configure and monitor
R2's incomplete multipart lifecycle as an additional safety net; the app quota
is not a Cloudflare spending cap.

## Security boundary

The client uses the same user's Cloudflare Access identity as the browser.
It has no bucket credentials and cannot bypass application permissions.
Access tokens are sensitive and must live in an owner-only local file; this
preview has no polished device pairing or automatic login renewal. Session
expiry requires renewal. A signed JWT remains subject to the configured Access
session policy; do not claim instantaneous global revocation merely because a
request was made again.

Cached media exists on the workstation. Protect the workstation and its disk.
Revoking permission does not recall bytes already consumed by an application,
copied elsewhere or read by someone with access to the local account. This is
not end-to-end encryption or digital rights management.

## Validation required before a studio pilot

1. Run the unit, desktop, backup and actual Worker runtime tests.
2. Apply migrations only to an isolated test installation with synthetic media.
3. Verify the FUSE runtime on each supported OS, then open actual source media
   in the studio's editing and animation applications.
4. Measure cold and warm seeks, sustained playback, many small image sequences,
   network loss, token expiry, access removal and file-version changes.
5. Check quota recovery, interrupted uploads and a complete restore from backup.

Local protocol tests do not prove that Premiere, Resolve, Maya or a render farm
will meet performance and compatibility requirements. No such certification is
implied by this branch.

## Work remaining for a full replacement

- Native installation, signing, updates, secure device pairing and token renewal.
- Shared write leases, crash recovery and conflict UX; durable upload queues.
- Efficient dirty-block writes and background prefetch, without full-file rewrites.
- Scalable metadata and coordination, replacing the global write bottleneck.
- Application-specific locking and atomic-save semantics on macOS and Windows.
- Complete protected audit trails, operational monitoring, tested recovery and
  independent penetration testing against the customer's security requirements.

Major-studio acceptance depends on the deployed system, devices, operations and
the customer's review, not only the source code or its cloud provider.
