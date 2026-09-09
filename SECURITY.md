# Security model

This is a self-hosted file application, with one workspace per deployment. It is a pre-release implementation, not a security certification or a guarantee against every defect.

- Protect the entire app hostname with Cloudflare Access. The Worker independently verifies Access JWT signatures, issuer, audience, expiry, and required identity claims. Missing or incomplete authentication settings deny file APIs. There is no deployed development bypass.
- Keep R2 private. All ordinary file downloads pass through the Worker and its current access checks. Do not distribute bucket credentials to file recipients. Cloudflare administrators can access the underlying data independently of the app.
- The deployment owner has full access. Other identities need both Access admission and an effective app grant. A nearer nonempty grant list replaces inherited grants. Empty grants restore inheritance. Changes apply to subsequent requests; downloaded copies cannot be recalled.
- Uploads reserve storage quota before accepting content. Every saved object has a unique immutable key. Small uploads have a whole-file SHA-256 digest; multipart uploads verify individual part hashes and have no whole-file digest. Revision conflicts are rejected. Restoring content retains later history.
- Mutating browser requests require an exact same-origin header. File content downloads as an attachment. Custom CSS uses a narrow scoped grammar and cannot load external resources or replace login and sharing controls.
- Optional Gmail imports use the operator's OAuth client with read-only scope, single-use state, PKCE, and AES-GCM encryption of stored refresh tokens. Multiple mailboxes are isolated by identity and label cursor. Background polling is explicitly enabled by the owner, and review decisions bind to a source fingerprint and current queue version. Tokens and encryption keys are never included in exports of the file index. Complete database backups can contain encrypted tokens.

## Operator responsibilities

Protect your Cloudflare, GitHub, Google, backup, and device accounts. Keep secrets out of source control. Back up D1 and R2 together, retain secure recovery configuration, review teammates and updates, and verify restored permissions. This is not end-to-end encryption: your cloud operator and authorized administrators can operate the storage and application.

Gmail import does not verify the legal or business meaning of a document. The application provides no compliance certification, signature verification, malware scanner, or guaranteed support response.

## Reporting a problem

Do not post secrets, tokens, private filenames, customer documents, or exploit details in a public issue. Use a private security-reporting channel if the repository operator has enabled one. Operators should restrict or disable an affected deployment while investigating suspected unauthorized access. This repository does not promise an unattended monitoring or incident-response service.


## Media-drive preview

The optional desktop client stores media blocks on the user's disk and requires
an online authorization check before serving them. It does not revoke copies
already read by applications or accessible to the local account. Cloudflare
Access session expiry/revocation behavior still applies. Protect token files,
cache directories and endpoints. No offline-access or DRM guarantee is made.

Multipart uploads use per-part hashes and immutable committed versions; the
whole-file SHA-256 field is null for these versions. This preview has not had an
independent penetration test or a major-studio assessment. See
[media-drive scope](docs/media-drive.md).
