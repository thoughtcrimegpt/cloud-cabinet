# Install your cabinet

## 1. Create your own accounts

Create a [Cloudflare account](https://dash.cloudflare.com/sign-up) and a [GitHub account](https://github.com/signup). In Cloudflare, enable R2 and accept its billing terms. Cloudflare may require a payment method even when your usage fits the free allowance. No storage is billed to the project publisher.

You can use a Cloudflare-provided `workers.dev` address without purchasing a domain. Companies can attach their own domain later. Cloudflare recommends a domain or route for business-critical production use.

## 2. Deploy

Use [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fthoughtcrimegpt%2Fcloud-cabinet). Select your GitHub account, repository name, Worker name, database name, and bucket name. Keep the R2 bucket private.

Accept the provided build and deploy scripts. D1 migrations run against binding `DB`, so changing the database’s display name is supported. The placeholder database ID in the template is replaced by Cloudflare’s deploy flow; never point it at another application’s database.

If the deploy flow requires all three Access settings before the Access application exists, enter the literal value `not-configured` for those fields, then replace them with the real secrets in step 4. This deliberately fails authentication configuration until setup is complete. An unconfigured installation only exposes a generic setup screen. It cannot list, upload, or download files.

## 3. Protect the hostname

In the Worker’s settings, enable Cloudflare Access protection for its `workers.dev` hostname. In Cloudflare Zero Trust, configure the resulting self-hosted Access application for the **entire exact hostname**, including `/api/*`. Allow only the owner’s email to start. An email one-time PIN can be used as the identity provider.

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

## Add teammates

First allow each person through Cloudflare Access. Then, as the workspace owner, use Manage access on a file or folder to grant Viewer or Editor. Being admitted through Access alone does not grant access to files. Sharing inside the app does not send an invitation or change your Access policy.

## Official references

- [Deploy buttons and automatic provisioning](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Protect a Worker with Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
