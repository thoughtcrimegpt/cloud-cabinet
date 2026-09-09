# Cloud Cabinet

Media-drive engineering preview: authenticated ranged reads, resumable large uploads, and an optional read-only desktop client. See [scope, setup and remaining work](docs/media-drive.md). This branch is not a production LucidLink replacement.

**Public beta, v0.2.0-beta.1.** A private file and project workspace in **your own Cloudflare account**, accessible from your phone or computer.

Keep files, versions, permissions, project checklists, and optional Gmail attachment intake together. Each operator supplies their own Cloudflare resources and Google connection. The publisher does not host customer files, receive credentials, or run a shared backend.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fthoughtcrimegpt%2Fcloud-cabinet)

The deployment flow copies the repository to your GitHub account and provisions a Worker, D1 database, and private R2 bucket. Finish [Cloudflare Access setup](docs/setup.md) before adding real files. A deployed Worker alone is not a completed installation.

## What you can do

- Upload, download, search, rename, move, and organize files and folders. Import a folder tree from a compatible desktop browser and use reversible trash.
- Upload revisions and restore earlier content while retaining immutable version history.
- Grant Viewer or Editor access to selected files and folders. Every download checks current access.
- Keep current projects prominent with Ready to launch, Active, Under contract, and Closing stages. Browse Closed and Archived work separately.
- Customize project document checklists. Filename matches suggest evidence to review; they never certify signatures or completion.
- Connect multiple Gmail accounts using your own Google OAuth project. Import from explicit labels, configure optional background polling, and review filing decisions.
- Customize company name, accent color, and constrained CSS.
- Back up the database and cloud objects, verify checksums, and test recovery in an isolated location.

Start with an empty cabinet. No customer records, preconnected mailboxes, private installation settings, publisher tracking, or paid AI service is included. Existing files stay in their original folder structure until the owner changes it.

## Set it up

1. [Install and protect your cabinet](docs/setup.md).
2. [Choose your storage quota and understand billing](docs/storage.md).
3. [Organize projects and document checklists](docs/projects.md).
4. [Connect Gmail and enable optional background intake](docs/gmail.md).
5. [Set branding and sharing](docs/company.md).
6. [Make and verify backups](docs/backup.md), then follow [update and recovery guidance](docs/operations.md).

Upgrading an existing installation? Read [the migration checklist](docs/upgrade.md) first. Preserve your own database, bucket, secrets, and Access settings.

## Boundaries

- One deployment is one private workspace. Independent customers deploy separate copies.
- Browser uploads support **100 GiB per file** through resumable multipart uploads in this engineering preview. Gmail attachments retain their **20 MiB** limit.
- The default quota is **10 GB**, including retained versions and trash. Owners can set another quota, including 1 TB. It is an application guard, not a provider billing cap.
- Gmail polling is opt-in and bounded. It is periodic, not an instant push feed. Large backlogs take multiple runs; review exceptions and connection health.
- Gmail is read-only. It never sends, deletes, archives, labels, or marks mail as read. Checklists do not determine legal status, deadlines, signature validity, or document approval.
- There is no desktop folder watcher, offline sync client, public share-link service, permanent-delete interface, automatic version pruning, or managed support service.
- MIT-licensed software is free to use. Your own hosting, storage, operations, backups, optional domain, and any Google verification requirements remain your responsibility. Free software does not mean unlimited free infrastructure or zero maintenance.

## Development and validation

Use Node 22.13 or newer (Node 24 recommended), plus Python 3.10 or newer for backup tools.

```sh
npm ci
npm run check
npm test
npm run test:backup
npm run build
npm run test:runtime
npm run db:local
npm run dev
```

The build packages the web interface and performs a Worker dry run. It does not deploy or modify a cloud account. Tests use synthetic identities and isolated D1/R2 storage. An unconfigured local instance shows setup guidance and denies file APIs; there is no production authentication bypass.

## Architecture

React/Vite UI, Cloudflare Worker API, D1 index, private R2 objects, Cloudflare Access JWT verification, and optional Google OAuth. Downloads pass through the authenticated Worker. Gmail refresh tokens are encrypted in the operator's D1 database using a key held in their Worker secrets. No publisher service is required at runtime.

See [API.md](API.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md). Licensed under [MIT](LICENSE), including commercial use subject to its license notice requirements.
