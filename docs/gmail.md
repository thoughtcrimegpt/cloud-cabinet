# Optional Gmail intake

Each installation supplies its own Google Cloud project and OAuth client. No publisher OAuth client or token service is involved. You can connect more than one mailbox; each mailbox owner must grant access. Only the cabinet owner manages these connections and reviews.

## 1. Prepare your Google project

1. Create a project in the [Google Cloud console](https://console.cloud.google.com/), then enable the Gmail API.
2. Configure Google Auth Platform branding, audience, support details, and data access for your actual use. Request `https://www.googleapis.com/auth/gmail.readonly`.
3. Create a **Web application** OAuth client.
4. Add the exact redirect URI `https://YOUR-APP-HOST/api/gmail/callback`, using your deployed hostname, with no trailing slash.
5. While the project is in Testing, add every mailbox you intend to connect as a test user.

Protect the entire app with Cloudflare Access before connecting. The callback uses the cabinet owner's authenticated session, a single-use state value, and PKCE. A Google mailbox may have a different email from the cabinet owner; consent from that mailbox is still required. Reconnecting an existing mailbox must use the same Google account.

## 2. Add Worker secrets

| Secret | Your value |
| --- | --- |
| `GMAIL_CLIENT_ID` | Web application OAuth client ID |
| `GMAIL_CLIENT_SECRET` | That client's secret |
| `GMAIL_TOKEN_KEY` | Base64 encoding of 32 cryptographically random bytes |

Generate the encryption key locally with `openssl rand -base64 32` and enter it in your Worker secret settings. Never commit the result. Refresh tokens are AES-GCM encrypted in your D1 database. The encryption key is held in your own Worker secrets. Keep the key stable while accounts are connected; changing it requires reconnecting accounts or restoring the previous key.

## 3. Connect and choose what to import

1. Open Gmail intake as the cabinet owner and connect the first mailbox. Use **Connect another mailbox** for another account.
2. In that Gmail account, create a label such as `Cabinet` and apply it to the messages you want included. Gmail filters can apply this label to future incoming messages.
3. Select the mailbox, enter the exact label name, and choose a cabinet destination folder.
4. Save a filing rule. Leave **Review first** enabled initially. Run a label scan to verify the scope and inspect the review queue.
5. File reviewed attachments into a chosen folder. Defer an uncertain attachment or dismiss an unrelated one. Deferred items remain available for a later retry. Original Gmail messages are unchanged.

A label rule can file automatically when Review first is disabled. Closed or archived projects always route to review. Rules specify destinations explicitly; this version does not use AI to infer addresses or decide which business facts are true. Use separate labels for separate projects.

Review entries show selected message headers, attachment details, mailbox and source identity. Assignment re-fetches the source and checks that it matches the recorded fingerprint. Imported files retain Gmail provenance, and retries reuse the source identity instead of creating another file.

## 4. Enable background polling, if wanted

Scheduling has two opt-in controls: enable background polling on the desired label rule in the app, and add a Worker Cron Trigger in your own deployment. The public template has an empty cron list.

For example, edit your private `wrangler.jsonc`:

```json
"triggers": {
  "crons": ["*/10 * * * *"]
}
```

Then deploy your own installation:

```sh
npm run deploy
```

This checks every ten minutes, subject to Cloudflare trigger propagation and execution. Each invocation selects at most two rules, fairly ordered by their last run. Each rule processes one message and at most two small attachments or one large attachment. Large backlogs take multiple invocations. Connections, labels, and current queue state are checked on each run. Review recent rule activity/errors in the app.

This is polling, not instant delivery. It does not require keeping a browser or computer open. To pause a rule, disable its background setting. To pause all background work, remove the cron or enable maintenance mode. Disconnect removes usable credentials and disables that mailbox's rules. Already downloaded files remain in the cabinet.

## Limits and review meaning

- Browser uploads and Gmail attachments are capped at **20 MiB per file**. Attachment responses are decoded in bounded chunks. Message metadata has its own 12 MiB response limit and a 200-attachment ceiling. Oversized or malformed messages are reported; check the original Gmail message when an import reports an exception.
- Drafts are skipped. Inline images identified as email body or signature content are excluded; attachments such as PDFs are not dismissed merely because a message has inline content.
- Saved files are unverified documents. A filename, a Gmail import, or a checklist match does not verify signatures, contract completeness, deadlines, or approval.
- Gmail calls are read-only. The app does not send, delete, archive, apply labels, or mark messages as read. Labels narrow the application's import scope, although Google's granted `gmail.readonly` scope technically permits broader mailbox reads.
- Owner rotation does not transfer old owners' Gmail grants. Reconnect under the new cabinet owner.

## Google consent and expiry

`gmail.readonly` is a restricted scope. External Testing authorizations normally expire after seven days. Production removes that testing limit but does not waive verification requirements or make credentials permanent. Qualifying internal or personal applications may have exemptions; broader external use may require verification and a security assessment. Each operator must meet Google's requirements for their actual use.

Disconnecting removes the app's usable stored token. To revoke authorization at Google as well, remove the app from [Google Account connections](https://myaccount.google.com/connections).

References: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google audience and Testing](https://support.google.com/cloud/answer/15549945), [verification exemptions](https://support.google.com/cloud/answer/13464323), [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
