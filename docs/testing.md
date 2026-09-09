# Release validation

The 0.2 beta is tested with synthetic accounts and isolated storage. Tests do not use or publish a live customer's documents, credentials, or cloud resources.

Run the complete checks from a clean checkout with Node 24 and Python 3.10 or newer:

```sh
npm ci
npm run check
npm test
npm run test:backup
npm run build
npm run test:runtime
```

The release suite contains 54 JavaScript tests, 5 Python backup tests, and a built-Worker integration test with real Miniflare D1/R2 bindings. It checks authentication, inherited permissions, immutable versions, source deduplication, multi-mailbox isolation, review races, exact 20 MiB decoding, project visibility, checklist revision history, folder imports, corruption detection, and offline restore.

A local synthetic browser check covers creating checklist items, saving Gmail label rules, current versus archived projects, and layout at 375 pixels. Google provider responses are mocked in automated tests; each installation must still complete real Google consent and confirm a small import with its own mailbox. The tests do not certify security, Google verification eligibility, or contractual document sufficiency.

GitHub Actions runs the checks on pushes to main and pull requests. It does not deploy a customer account or require cloud credentials.
