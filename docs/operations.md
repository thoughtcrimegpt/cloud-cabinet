# Backups, recovery, and updates

One installation belongs entirely to its operator. The publisher has no access to recover your account, restore your files, or maintain your deployment. There is no central hosting subscription, but your own provider charges and operational work still apply.

## Make a complete backup

Pause file changes while taking a consistent backup. Keep these three things together in a private, dated backup location:

1. **The file index:** sign into the app as owner and choose Export file index. Save the JSON response. It maps human-readable names and folders to R2 object identifiers and every retained version. It also contains sharing rules and Gmail provenance, so treat it as private.
2. **The D1 database:** from your own installation checkout, export the complete database with the command below. It includes settings and may contain an encrypted Gmail refresh token.
3. **The R2 bucket:** copy every object to your backup location using the Cloudflare dashboard or an S3-compatible client. Use a read-only R2 API credential restricted to this bucket. Store credentials in your client's secure configuration, never in Git or a shared document.

```sh
npx wrangler d1 export DB --remote --config wrangler.jsonc --output backup.sql
```

Keep your Worker configuration, required secrets, and Cloudflare Access configuration in a separate secure recovery record. A database export without the associated R2 objects cannot restore file contents. An R2 copy without the index cannot reconstruct the app's names, folder structure, or access rules.

## Access files directly from the cloud

Owners can open their bucket under Cloudflare R2 and download an object. Find the desired file's entry and current version in the exported index, then use that version's `objectKey` to locate the R2 object. Earlier version records identify the earlier content. The `sha256` value lets a recovery tool verify the downloaded bytes.

For recurring backups, use an S3-compatible client against the endpoint displayed by your R2 account. [Cloudflare's S3 setup guide](https://developers.cloudflare.com/r2/get-started/s3/) explains endpoints and credentials. Direct bucket credentials grant administrator access outside the app's Viewer and Editor rules. Ordinary recipients should use the app URL.

Do not rename, replace, or delete app-managed R2 objects. Do not enable public bucket access or automatic object-expiration rules. Uploading directly into R2 does not register a file in the application. The app stores immutable object identifiers, while D1 supplies familiar folder and file names.

## Recovery and retained versions

Restore backups into a separate, private test installation first. Keep it owner-only while checking the database, bucket binding, representative downloads, file hashes, and previous versions. Review restored grants before admitting teammates. Confirm the Gmail encryption key matches the database, or disconnect and reconnect Gmail. Do not overwrite a live installation until the restored copy has been verified.

Version history is implemented by the app, not by native R2 object versioning. Restoring a version creates a new history record referring to the earlier immutable object. Trash retains data and continues to use storage. This release has no permanent deletion or history-pruning interface.

## Update your installation

Review changes before updating your own GitHub copy. Back up first, especially before migrations. Preserve your database and bucket bindings, quota, secrets, and Access settings. Never replace a working binding with this template's placeholder database ID.

```sh
npm ci
npm run check
npm test
npm run build
npm run test:runtime
npm run deploy
```

The deploy command builds the interface, applies migrations to binding `DB`, and deploys while preserving dashboard variables. Secrets remain outside the repository. A code rollback does not reverse database migrations. Test download, upload, version restore, and a restricted teammate account after an update.

There is no automatic update agent. Review security updates, provider changes, usage, and access permissions regularly. Browser uploads require an internet connection; a home-screen shortcut is not an offline sync client.
