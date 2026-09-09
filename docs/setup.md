# Install your cabinet

## 1. Create your own accounts

Create a [Cloudflare account](https://dash.cloudflare.com/sign-up) and a [GitHub account](https://github.com/signup). In Cloudflare, enable R2 and accept its billing terms. Cloudflare may require a payment method even when your usage fits the free allowance. No storage is billed to the project publisher.

You can use a Cloudflare-provided `workers.dev` address without purchasing a domain. Companies can attach their own domain later. Cloudflare recommends a domain or route for business-critical production use.

## 2. Deploy

Use [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fthoughtcrimegpt%2Fcloud-cabinet). Select your GitHub account, repository name, Worker name, database name, and bucket name. Keep the R2 bucket private.

Accept the provided build and deploy scripts. D1 migrations run against binding `DB`, so changing the database’s display name is supported. The placeholder database ID in the template is replaced by Cloudflare’s deploy flow; never point it at another application’s database.

If the deploy flow requires all three Access settings before the Access application exists, enter the literal value `not-configured` for those fields, then replace them with the real secrets in step 4. This deliberately fails authentication configuration until setup is complete. An unconfigured installation only exposes a generic setup screen. It cannot list, upload, or download files.

## 3. Protect the hostname

Open your Worker’s **Access** tab, choose **Protect this Worker behind Access**, and select **All traffic**. The default **Previews only** option does not protect the production app. Choose an Allow policy restricted to the owner’s email, then apply Access. Some dashboard versions place this control under Settings or Domains instead.

In Cloudflare Zero Trust, review the resulting self-hosted Access application. Protection must cover the entire production app, including `/api/*`. Allow only the owner’s email to start. An email one-time PIN can be used as the identity provider. If the Deploy form offers **Protect with Cloudflare Access**, you can enable it there and review its scope and policy after deployment.

Record the team domain (`https://YOUR-TEAM.cloudflareaccess.com`) and the application’s audience (AUD) tag. Do not use an Access Bypass or Everyone policy. Leave preview URLs disabled. If you add a custom domain, protect that hostname too and confirm the correct audience tag.

## 4. Set your Worker secrets

Open Workers & Pages → your Worker → Settings → Variables and Secrets. Add these as **secrets**, not values committed to GitHub:

| Secret | Value |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | Your full `https://YOUR-TEAM.cloudflareaccess.com` address, without a trailing slash |
| `ACCESS_AUD` | Your Access application’s 64-character audience tag |
| `OWNER_EMAIL` | The email you use to sign in through Access |

These names are declared in the template; their values belong only to your deployment. Deploy the changed settings, then open your app URL and sign in. The Worker verifies the signed Access token, issuer, audience, and expiry on every file request. A forged email header is insufficient.

## 5. Verify before adding real files

Upload a small test file, download it, upload a new version, and restore the old version. Open the app in a private browser window and confirm it requires Access sign-in. After adding a teammate, test with that person’s account that only shared files appear.

Then bookmark the app on your computer or use your phone browser’s Add to Home Screen action. It remains a web app requiring an internet connection.

### Manual CLI installation

If the Deploy button is unavailable or is connected to the wrong GitHub account, deploy a private clone with Wrangler:

```sh
git clone https://github.com/thoughtcrimegpt/cloud-cabinet.git
cd cloud-cabinet
# Use Node.js >= 22.13.0, as required by package.json.
npm ci
npx wrangler login
```

Create fresh resources in your own Cloudflare account. Use unique names, and keep these resources separate from any other application:

```sh
npx wrangler d1 create YOUR_UNIQUE_D1_NAME
npx wrangler r2 bucket create YOUR_UNIQUE_R2_BUCKET_NAME
```

Edit `wrangler.jsonc` using the D1 command's returned UUID and names you created. Replace `name`, `d1_databases[0].database_name`, `d1_databases[0].database_id`, and `r2_buckets[0].bucket_name`; keep the `DB` and `FILES` binding names. Do not commit personal resource IDs or deployment-specific values to a public clone. Keep your configured clone private and do not mix its database or bucket with another app.

Create a local `.env` file containing the placeholders below. Until the Access application exists, these values keep authentication disabled:

```dotenv
ACCESS_TEAM_DOMAIN=not-configured
ACCESS_AUD=not-configured
OWNER_EMAIL=not-configured
```

Deploy the app and upload those values as Worker secrets:

```sh
npm run deploy -- --secrets-file .env
```

`npm run deploy` builds the web app, applies the remote D1 migrations, and deploys the Worker. After completing step 3, replace the placeholders with the real values using `wrangler secret put` again (or `wrangler secret bulk` with a local, uncommitted `.env` or JSON file), then run `npm run deploy` again. Never commit that secrets file.

## Add teammates

First allow each person through Cloudflare Access. Then, as the workspace owner, use Manage access on a file or folder to grant Viewer or Editor. Being admitted through Access alone does not grant access to files. Sharing inside the app does not send an invitation or change your Access policy.

## Import an existing filing system

From Files, open the destination and choose **Upload folder** in a desktop browser that supports directory selection. This preserves relative subfolders, up to 2,000 files per batch and 20 MiB per file. Keep the page open until the batch finishes. Empty folders cannot be supplied by the browser directory picker.

Existing folders are reused. Name conflicts, unsupported paths, and failed or oversized uploads are reported, with existing files preserved. A retry does not silently overwrite a file. Use Upload new version for an intentional revision. Keep original files and compare the resulting counts before treating a migration as complete. Phones can upload individual files through their browser file picker; folder selection support depends on the browser.

## Official references

- [Deploy buttons and automatic provisioning](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Create a D1 database with Wrangler](https://developers.cloudflare.com/d1/wrangler-commands/#d1-create)
- [Create an R2 bucket with Wrangler](https://developers.cloudflare.com/r2/buckets/create-buckets/)
- [Protect a Worker with Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
