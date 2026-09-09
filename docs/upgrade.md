# Upgrade from 0.1 to 0.2

Keep the installation's own Cloudflare account, Worker, D1 database, R2 bucket, Access settings, and secrets. An upgrade changes code and adds tables; it does not migrate your data into a publisher account.

1. Review the changelog and new code. Use a private checkout for installation-specific configuration.
2. Turn on `MAINTENANCE_MODE` with the string value `true` in your Worker settings. Wait for existing imports/uploads to finish before taking a backup. Follow [the backup instructions](backup.md), including verification.
3. Update your checkout from the upstream release. Preserve the real D1 UUID, bucket name, Worker name, quota, Access configuration, and all secrets. Never substitute the public template's placeholder UUID for your working database.
4. Run the commands below. Resolve failed checks before deploying.

```sh
npm ci
npm run check
npm test
npm run test:backup
npm run build
npm run test:runtime
npm run deploy
```

The deploy script applies pending D1 migrations before deploying code. Existing entries, object keys, versions, and grants are retained. The new Gmail migration preserves the previous connection and import history. Keep `GMAIL_TOKEN_KEY` unchanged so existing encrypted tokens remain readable. An expired or revoked Google grant still requires reconnection.

5. Set `MAINTENANCE_MODE` to `false` after the new code is active. Confirm an existing download and version restore, a small upload, and a restricted teammate's access.
6. Open Projects and designate the folders you want to track. No customer taxonomy is imposed automatically.
7. Review Gmail connections and destinations. Configure scheduling explicitly if desired; the template's cron list starts empty. Check the [Gmail guide](gmail.md) before enabling background work.
8. Make another verified backup after the upgrade succeeds.

Test migrations on a separate private copy first for important installations. A code rollback does not reverse D1 migrations. Keep the pre-upgrade backup until the new installation is verified. Do not point a test instance at the production bucket/database or run its Gmail polling against the same mailboxes.
