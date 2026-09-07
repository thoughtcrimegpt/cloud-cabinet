# Cloud Cabinet

**Private release candidate.** Public distribution and license terms are pending. The deployment link below is prepared for the public release and is not available to other users while this repository is private. No reuse or redistribution license has been granted yet.

A private file manager in **your own Cloudflare account**. Open it on your phone or computer. Keep your files, database, access policy, and optional Gmail connection under your control.

This is an installable application, not a shared storage service. The project publisher does not host your files, receive your credentials, or bill you for storage.

[Deploy to your Cloudflare account](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fthoughtcrimegpt%2Fcloud-cabinet)

The deployment flow copies this repository into your GitHub account and provisions the app, D1 database, and private R2 bucket. You must finish the [Access setup](docs/setup.md) before any file API can be used. **A successful deployment is not the same as a completed security setup.**

## What it does

- Upload, download, search, organize folders, move, rename, and use reversible trash.
- Keep immutable file versions. Upload a revision explicitly and restore earlier content without removing later history.
- Share a file or folder with viewers and editors admitted through your Cloudflare Access policy. The installation owner controls permissions.
- Apply a company name, accent color, and limited, scoped CSS.
- Optionally import attachments from a Gmail label using your own Google OAuth project. Imports are manually started and read-only.
- Export the file/version index for use with your R2 backups.

Start with an empty cabinet. No sample customer data, preconnected accounts, tracking, advertising, or remote publisher service is included.

## Install and use

1. [Create your accounts and install](docs/setup.md).
2. [Understand storage and billing](docs/storage.md).
3. [Set up optional Gmail imports](docs/gmail.md).
4. [Configure company branding and sharing](docs/company.md).
5. [Back up and update your installation](docs/operations.md).

## Current boundaries

- One installation is one private workspace. Each independent customer deploys their own copy.
- Browser uploads are limited to **20 MiB per file** in this first release. Gmail imports are limited to **8 MiB per attachment**, two attachments per import step. The interface tells you when another step is needed.
- Storage defaults to a **10 GB app quota**, counting retained versions and trash. This quota is not a Cloudflare billing cap. Owners can change it in their own configuration.
- There is no desktop folder watcher, offline file cache, public share-link system, automatic Gmail monitoring, or unlimited-file-size promise.
- Trash is reversible. This release has no permanent-delete button or automatic history pruning. Retained objects continue to occupy storage.
- Gmail saves attachments as unverified files. It does not infer legal status, signed state, deadlines, or document approval.
- Hosting this application carries operational responsibility. Security updates, backups, access reviews, and provider changes still need attention.

## Development

Use Node 22.13 or newer (Node 24 recommended).

```sh
npm ci
npm run check
npm test
npm run db:local
npm run dev
```

Unconfigured local instances show the setup page and deny all file APIs. There is deliberately no development password or public authentication bypass. The tests use isolated fake identities in test code, never in the deployed Worker.

```sh
npm run build
```

The build packages the browser interface and performs a Worker dry run. It does not deploy a service or charge a customer account.

## Architecture

React/Vite interface, Cloudflare Worker API, D1 file index, private R2 objects, Cloudflare Access JWT verification, and optional Google OAuth. All data requests go to the installation’s own origin. Each download is authorized by the Worker. The bucket must remain private.

See [SECURITY.md](SECURITY.md) for the security model and reporting guidance. Public release terms will be added before distribution.
