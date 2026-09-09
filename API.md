# API contract
All /api routes require verified Cloudflare Access JWT, except GET /api/setup which reveals booleans only. One deployment is one private workspace. OWNER_EMAIL (normalized exact) is administrator. Other Access users see only entries shared with their email, inherited downward. No shared vendor backend.

JSON errors {error: string}. Entry {id,parentId,name,kind:'file'|'folder',size,mime,currentVersion,createdAt,updatedAt,trashed,role:'owner'|'editor'|'viewer'}. Version {id,entryId,size,mime,createdAt,createdBy,source}. API uses camelCase. Dates ISO.
GET /api/setup -> {configured:boolean}
GET /api/me -> {email,isOwner,maxStorageBytes,maxUploadBytes}
GET /api/entries?parent=<id or root>&q=<optional>&trash=1 -> {entries,ancestors:[{id,name}],usedBytes,limitBytes}. Owner root shows top entries; nonowner root lists highest directly shared entries. Search only across accessible entries. trash only owner. Pages contain at most 200 candidates, with nextOffset and truncated. Pass offset=nextOffset for the following page; refresh after concurrent changes. canCreate reports whether the current view allows new entries.
POST /api/folders {parentId:'root'|id,name} -> {entry}
POST /api/uploads {parentId,name,size,mime,entryId?:existing file,baseVersion?:current version} -> {uploadId,url}. New file reserved with UUID, not visible until ready. Existing file new version using optimistic baseVersion. PUT returned /api/uploads/:uploadId with raw file -> {entry}. UPLOAD MAX 20MiB for v0.2, no silent overwrite. Pending reserve atomic against MAX_STORAGE_BYTES, count all stored versions incl trash; uncompleted reservations expire only after object reconciliation.
PATCH /api/entries/:id {name?,parentId?} -> {entry}. Move owner-only, no cycles, no move into trash. Rename editor permitted.
POST /api/entries/:id/trash {} and /restore {}. Only owner can trash/restore folders (nonempty folder trash rejected); editors can trash file. Trash retained, no permanent deletion API v0.2.
GET /api/entries/:id/download?version=<optional UUID> streamed with attachment disposition, nosniff; authorize entry on every request, never public bucket URL.
GET /api/entries/:id/versions -> {versions}; POST /api/entries/:id/versions/:versionId/restore {baseVersion} points to old immutable content via new version; owner/editor only; conflicts409. No bytes duplicated for restore.
GET /api/entries/:id/access -> {grants:[{email,role:'viewer'|'editor'}],inherited:boolean}; PUT same body {grants} owner-only; empty grants inherits parent grants, owner retains full access. Share does not email/invite and Access policy must separately admit recipient.
GET /api/settings -> {companyName,accentColor,customCss}. PUT same owner-only. companyName max80, color valid hex, customCss max8000 enforced owner CSS security: no @import/url/external loads, reject closing style tags, reserved chrome not inside .brand-surface. CSS is validated server-side.
GET /api/export -> owner-only metadata manifest (files and versions with object keys for own R2 backup, not signed URLs).

## Projects and evidence

- `GET /api/projects?archived=1&offset=0`: current projects by default; `archived=1` selects closed and archived. Returns `{projects,archived,nextOffset}`; at most 200 candidates per page, filtered by current inherited access.
- `POST /api/projects {folderId,name?,stage?}`: owner designates an existing folder. Default stage is `ready_to_launch`. No files move.
- `GET /api/projects/:id`: `{project,filesScanned,inventoryCapped,checklist}`. Evidence links bind to the actual current version. Scans cap at 500 candidates.
- `PATCH /api/projects/:id {stage,name?}`: owner changes stage. Stages: `ready_to_launch`, `active`, `under_contract`, `closing`, `closed`, `archived`.
- `GET/PUT /api/projects/:id/checklists`: PUT `{checklists:[{id?,name,pattern,required,applicability}]}`, owner-only, max 50 definitions. Filename globs support `*` and `?`; max pattern length 120. Applicability is `always` or one stage. Preserve IDs on edits; removing a definition retires it and retains reviews. Definition edits invalidate earlier evidence confirmations.
- `POST /api/projects/:id/checklists/:checklistId {entryId,version,action}`: owner review of a project file's current version; action `confirmed` or `dismissed`. Reviews are immutable. Confirmation is a human evidence note, not a signature or legal-completeness check.
- Inventory states: `needs_review`, `not_found`, `unassessed`, `not_applicable`, `confirmed`. A capped scan returns `unassessed`; media and template/example filenames do not count as evidence.

## Gmail

All Gmail routes are owner-only. JSON mutations require the same-origin header through the Worker.

- `GET /api/gmail/status` returns `{configured,connected,email?,mailboxes,reviewCount}`. Each mailbox has `mailboxId`, `email`, `enabled`, and `labels`, including rule settings and last polling status.
- `POST /api/gmail/connect {mailboxId?}` returns `{url}` for OAuth. Omit ID to add an account; supply ID to reconnect the same mailbox. `GET /api/gmail/callback` consumes a single-use owner-bound state.
- `DELETE /api/gmail/mailboxes/:id` disconnects that mailbox and disables its rules. Legacy `POST /api/gmail/disconnect {mailboxId?}` selects the only account if ID is omitted; multiple accounts require selection.
- `PUT /api/gmail/mailboxes/:id/config {label,destinationId,scheduled,reviewOnly,enabled}` saves one exact-label rule. Review defaults to true; scheduling defaults to false. `destinationId` is a folder ID or `root`.
- `POST /api/gmail/import {mailboxId,label,parentId}` scans one message and up to two small attachments or one large attachment. Returns `{imported,skipped,queued,remaining,issues}`. With an explicit mailbox and no rule, attachments enter review. Legacy single-account calls without `mailboxId` remain explicit manual destination imports unless an existing rule requires review.
- `GET /api/gmail/review?state=pending&offset=0` returns `{reviews,nextOffset}` with up to 100 items. States: `pending`, `filing`, `filed`, `dismissed`, `deferred`. Metadata includes selected headers, source fingerprint identity, current queue version, and filing error.
- `POST /api/gmail/review/:id/assign {destinationId,version}` re-fetches and verifies the original attachment, then files it. `dismiss` and `defer` accept `{version}`. Deferred items can be explicitly reassigned; active leases reject concurrent decisions. Expired filing leases can resume at the previously chosen destination.
- Scheduled handler requires valid Access configuration, the current `OWNER_EMAIL`, Gmail secrets, an enabled rule, and a configured Cron Trigger. No cron is enabled in the template. It rotates through at most two rules per invocation.

Gmail is read-only. No tokens are returned in status or file-index exports. Full D1 backups contain encrypted refresh tokens and private source metadata.

## Maintenance

Set `MAINTENANCE_MODE` to the string `true` to deny browser mutations and skip background polling. `/api/me` includes `maintenance`. Existing reads remain available. Wait for in-flight work before copying D1 and R2; see `docs/backup.md`.
