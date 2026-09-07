# Storage belongs to you

Files live in the private R2 bucket in your Cloudflare account. Folder names, version history, and app permissions live in your D1 database. Both are required to restore the full workspace.

Use the app from any phone or computer for normal file access. The Cloudflare dashboard can also browse and download the underlying objects. R2 supports S3-compatible clients for backups and administration.

Direct R2 access is an administrator capability. **Cloudflare credentials bypass the application’s viewer/editor rules.** Do not give bucket credentials to ordinary file recipients. They should use the app.

R2 object keys are immutable storage identifiers. The app supplies human-readable folders and filenames. Use the owner’s `/api/export` manifest to map raw objects to files and versions. Directly uploading arbitrary objects into R2 does not add them to the application index. Do not rename or delete app-managed objects in the dashboard.

## Paying for storage

Enable R2 in your Cloudflare account. You pay Cloudflare for measured storage and operations, rather than buying a fixed-capacity drive from this project.

As checked on September 7, 2026, R2 Standard includes 10 GB-month of storage, 1 million Class A operations, and 10 million Class B operations each month. Beyond the allowance, standard storage is $0.015 per GB-month. Roughly 1,000 GB stored for a full month is $14.85 after the 10 GB allowance, before billable operations and taxes. Download transfer out of R2 has no egress charge. Rates and allowances can change.

Use the [official R2 pricing page](https://developers.cloudflare.com/r2/pricing/) for current billing details. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) apply independently. An active company workload may need paid compute or other services.

## App quota

`MAX_STORAGE_BYTES` defaults to `10000000000` (10 GB). Change the value in your own `wrangler.jsonc` and redeploy when you want a different application quota. For 1 TB, use `1000000000000`.

This is an application upload guard, **not a spending cap at Cloudflare**. It counts original files, saved revisions, retained trash, and in-progress reservations. Version restore reuses the old object instead of storing identical bytes again. Operations, other apps in your account, and objects uploaded directly to the bucket can still affect your bill.

The current app caps browser uploads at 20 MiB per file. Larger-file multipart uploads are not included in this release. Do not buy storage assuming this version supports arbitrarily large files.
