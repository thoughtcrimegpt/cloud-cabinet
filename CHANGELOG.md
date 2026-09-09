# Changelog

## 0.2.0-beta.1

- Current-project dashboard with configurable stages and document inventory checklists.
- Multiple owner-connected Gmail mailboxes with explicit label scope, optional background polling, and a source-bound review queue.
- Gmail attachment limit increased to 20 MiB with bounded decoding and integrity checks.
- Portable backup verification and isolated recovery tools.
- Read-only maintenance mode for consistent backups.
- Updated installation, migration, and operating instructions; automated repository checks.

Existing installations must back up first and apply all new D1 migrations. Keep the same D1/R2 bindings, Access configuration, owner identity, and Gmail encryption key. New connector scheduling is disabled until the operator configures it.

## 0.1.0-beta.1

Initial public beta: private file/folder storage, immutable versions, access grants, company customization, manual Gmail label imports, and customer-owned Cloudflare deployment.
