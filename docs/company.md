# Company branding and sharing

The owner can set a company name (up to 80 characters), an accent color (a valid hexadecimal color such as `#2563eb`), and limited custom CSS (up to 8,000 characters). Custom CSS is scoped to the branded surface. External imports and loads, `url(...)`, closing style tags, and reserved application chrome selectors are rejected. Keep branding content factual and suitable for everyone who can access the workspace.

Sharing has two layers. First, the recipient must be admitted by the Cloudflare Access policy protecting the whole hostname. Second, the owner grants Viewer or Editor access on a file or folder in the app. App sharing does not send an invitation or change Access policy.

| Role | Read shared entries | Download and inspect versions | Rename | Upload a new version | Trash files | Move entries or manage grants |
| --- | --- | --- | --- | --- | --- | --- |
| Owner | Yes, everywhere | Yes | Yes | Yes | Yes | Yes |
| Editor | Yes, within the effective share | Yes | Yes | Yes | Files only | No |
| Viewer | Yes, within the effective share | Yes | No | No | No | No |

Permissions inherit from ancestors. The nearest ancestor, or the entry itself, with a nonempty grant list supplies the effective grants for everything below it. A direct nonempty grant list therefore replaces the inherited list. Saving an empty list removes that override and restores inheritance. An empty list does not revoke access by itself, except that an unshared root has no nonowner access.

Permission changes apply to the next request. A download already handed to a client cannot be recalled.
