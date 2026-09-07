# Optional Gmail attachment import

The file manager works without Gmail. Each installation that wants imports must use its **own Google Cloud project and OAuth client**. There is no publisher-owned Google OAuth application or central token service.

## Prepare Google

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/).
2. Enable the Gmail API.
3. Configure Google Auth Platform branding, audience, support details, and data access for your own organization or personal use. Request only `https://www.googleapis.com/auth/gmail.readonly`.
4. Create a Web application OAuth client.
5. Add the exact redirect URI `https://YOUR-APP-HOST/api/gmail/callback`. Replace YOUR-APP-HOST with the hostname you actually use. Do not include a trailing slash.
6. While Testing, add the Google account you intend to connect as a test user.

## Add secrets in your Worker

| Secret | Value |
| --- | --- |
| `GMAIL_CLIENT_ID` | Your Web application OAuth client ID |
| `GMAIL_CLIENT_SECRET` | That client’s secret |
| `GMAIL_TOKEN_KEY` | Base64 encoding of 32 cryptographically random bytes |

Generate the encryption key locally with `openssl rand -base64 32`, then enter it into the Cloudflare secret field. Do not commit the result to a repository. Keep this key stable while a mailbox is connected. Changing it makes existing tokens unreadable; disconnect and reconnect if you intentionally rotate it.

The app stores the refresh token encrypted with AES-GCM in your D1 database. Your encryption key stays in your Worker’s secrets. Cloudflare account administrators can operate your application and storage, so protect that account.

## Import attachments

1. In Gmail, create a label such as **Cabinet** and apply it to messages whose attachments you want to save.
2. Sign into your cabinet as its owner. Open Gmail import, choose Connect Gmail, and grant read-only access to the desired Google account.
3. Open the destination folder, enter the exact Gmail label name, and start an import.
4. Continue when the interface says more items remain. Each step handles one message and up to two attachments.

Imports never send, delete, archive, label, or mark Gmail messages as read. They are manually triggered; there is no background schedule in this release. The selected label controls the import scope. File provenance records the mailbox, message, and attachment part. Gmail filenames are treated as data, never commands.

Automatic imports accept attachments up to 8 MiB each. Larger attachments and missing attachment data are reported as issues. Download those files from Gmail and upload through the app if they fit its 20 MiB upload limit. Inline images identified as email-signature/body content are skipped.

Importing an email does not verify a contract, signature, business fact, or deadline. Review the document before relying on it.

## Google consent and expiry

`gmail.readonly` is a restricted scope. In Google's External Testing mode, authorizations and offline refresh tokens normally expire after seven days. Moving to production removes that testing limit but does **not** waive Google's other requirements or guarantee tokens never expire.

Google provides exemptions for qualifying personal/internal use. An application offered broadly to external users may require verification and a security assessment. Each operator must configure the consent screen to accurately match their use and meet Google’s requirements. Creating an individual project is not a shortcut around those requirements.

Disconnect removes this app’s stored connection. To revoke Google authorization itself, also remove the app from your [Google Account connections](https://myaccount.google.com/connections).

Sources: [server-side OAuth](https://developers.google.com/workspace/gmail/api/auth/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [audience and Testing](https://support.google.com/cloud/answer/15549945), [verification exemptions](https://support.google.com/cloud/answer/13464323).
