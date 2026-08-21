# Tidepool token broker

This Cloudflare Worker exposes one route: `POST /token`. It verifies a GitHub
App user token, checks that its user can push to the requested repository, and
returns an installation token scoped to that repository.

## Local development

Use Node 22, then install this directory's standalone dependencies:

```sh
cd broker
npm install
```

Create an untracked `.dev.vars` containing the GitHub App configuration. Keep
the PEM value inside the quotes, including its `BEGIN`/`END` lines:

```dotenv
GITHUB_APP_ID="123456"
GITHUB_CLIENT_ID="Iv1.example"
GITHUB_CLIENT_SECRET="..."
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
```

Start the local Worker with `npm run dev`. For example:

```sh
curl -X POST http://localhost:8787/token \
  -H 'Authorization: Bearer <user-token>' \
  -H 'Content-Type: application/json' \
  --data '{"repo":"owner/name"}'
```

Run `npm test` and `npm run typecheck` from `broker/` for the standalone checks.

## Manual deployment and key rotation

Set `GITHUB_APP_ID` and `GITHUB_CLIENT_ID` in `wrangler.toml`. Store the two
secrets in Cloudflare; neither belongs in the repository:

```sh
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npm run deploy
```

To rotate the private key, generate a new key in the GitHub App settings, run
`npx wrangler secret put GITHUB_APP_PRIVATE_KEY` with the new PEM, verify the
Worker, and then delete the old key in the App settings.
