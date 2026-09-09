# Desktop media-drive engineering preview

A read-only source-media mount with online permission checks and a bounded
4 MiB block cache. A separate upload command creates files or explicit revisions.
This is not a shared writable drive, a production LucidLink replacement, or a
studio security certification.

## Requirements

- Python 3.10 or newer.
- For mounting only: optional `fusepy` and a compatible FUSE runtime. macOS
  requires a compatible macFUSE installation; Linux requires libfuse support.
  This repository does not install drivers or change system security settings.
- A test Cloud Cabinet deployment with migration `0006_multipart.sql` applied,
  Cloudflare Access configured and sufficient `MAX_STORAGE_BYTES` quota.
- An owner-only file containing the user's Cloudflare Access JWT. Obtain it
  through the installation's normal Access login tooling. Do not use a bucket
  key or a shared administrator credential. Renew the file when the session
  expires. Browser pairing and Keychain integration remain future work.

See [macFUSE backends](https://github.com/macfuse/macfuse/wiki/FUSE-Backends)
for OS requirements. Native mount and editing-app compatibility must be checked
on the target workstation. The old OSXFUSE 3.10.4 found on the development host
was not upgraded or used as proof of current macOS compatibility.

## Commands

Run from the repository root. Paths below are placeholders for your own private
files and empty mount directory. The core probe/upload commands need no FUSE.

```sh
python3 -m desktop --url https://cabinet.example.com --token /private/access.jwt --cache /private/cabinet-cache probe
python3 -m desktop --url https://cabinet.example.com --token /private/access.jwt --cache /private/cabinet-cache upload /media/shot.mov --parent FOLDER_ID
python3 -m desktop --url https://cabinet.example.com --token /private/access.jwt --cache /private/cabinet-cache mount /path/to/empty/mountpoint
```

Token files must be mode `0600` and owned by the current user. Use a dedicated
cache directory, not a directory containing other files. The default data-cache
limit is 512 MiB. Upload state lives separately inside `.uploads` and is not
subject to block eviction. Rerun the same upload command after interruption;
server-confirmed parts are hashed against the source before they are skipped.
Uploads accept files up to 100 GiB. Small and empty files use the legacy endpoint.

The upload CLI also accepts `--entry-id ID --base-version VERSION` for an explicit
revision and `--state PATH` for a private upload-state location. A source that
changes during upload causes an error. Failed/conflicting uploads retain state
for diagnosis. Cancel the server reservation before starting a different file
under the same reserved name. Upload reservations expire after 24 hours.

## Behavior and limits

- Reads fetch only needed blocks; seeking across a boundary fetches both blocks.
- Each open pins an immutable version. Reopen to see a later revision.
- Each read sends an authorized HEAD before serving even locally cached data.
  Kernel data caching is disabled and callbacks are serialized in this pilot.
- A server that ignores Range is rejected before its full body is read.
- HTTPS is required. The localhost HTTP override is available only to test code.
- Redirects, unsafe token files and cache symlinks are rejected.
- Application permissions are checked online, but Access JWT/session policy
  still governs session revocation. Previously delivered bytes cannot be recalled.
- Cache data is local plaintext protected by filesystem permissions. Protect the
  workstation and disk. This is not end-to-end encryption, DRM or offline access.
- Save project files, renders, sidecars and scratch data on a writable local
  volume. Apps requiring writes beside source media may not work with this mount.
- No Premiere, Resolve, Maya or render-farm compatibility/performance claim has
  been established. See [remaining milestones](../docs/media-drive.md).

## Tests

```sh
python3 -m unittest discover -s tests -p 'desktop*.py'
npm run build
npm run test:runtime
```

Runtime tests connect this Python client to the built Worker and actual local
D1/R2 emulation, force an interrupted upload, resume it and verify cached seeks.
They do not substitute for an OS mount or production load test.
