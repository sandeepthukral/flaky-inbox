# flaky-inbox

A Cloudflare Worker that replaces Mailinator for Action's end-to-end tests. It receives all mail for
two subdomains (catch-all), stores it in D1 (PDF attachments in a private R2 bucket), serves a
Mailinator-v2-compatible read API with static tokens, and has a small server-rendered web UI behind
Cloudflare Access. One Worker serves the API host and the UI host, told apart by the `Host` header.
Design: `docs/superpowers/specs/2026-10-27-flaky-inbox-design.md`.

| Host | Purpose | Protection |
|---|---|---|
| `ecom-staging.flaky-tests.uk` | Mail domain, staging tests | inbound mail |
| `ecom-production.flaky-tests.uk` | Mail domain, production tests (never real orders) | inbound mail |
| `mail-api.flaky-tests.uk` | API, base URL `https://mail-api.flaky-tests.uk/api/v2` | static token per mail domain |
| `mailinat.flaky-tests.uk` | Web UI | Cloudflare Access |

## Local development

Needs Node 24 (what CI and local development use; `pnpm cpu-sample` also needs Node's built-in TypeScript support) and pnpm (the version in `package.json`).

```sh
pnpm install
cp .dev.vars.example .dev.vars    # synthetic values only; .dev.vars is gitignored
pnpm exec wrangler d1 migrations apply flaky-inbox --local
pnpm dev                          # http://localhost:8787 (UI, dev auth) and 127.0.0.1:8787 (API)
```

Locally the UI is at `localhost:8787` (`UI_AUTH_MODE=dev`, no Access) and the API at `127.0.0.1:8787`.

Send a test mail to the local `email()` handler with Wrangler's local endpoint, posting raw MIME:

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/local/email?from=orders@sender.example&to=me@staging.test.example' \
  --data-binary @tmp/cpu-sample-60k.eml
```

A rejected mail (for example too large, via `setReject`) comes back as HTTP 400. Read it back with
the token from `.dev.vars`:

```sh
curl -H 'Authorization: stage-token-a' http://127.0.0.1:8787/api/v2/domains/staging.test.example/inboxes/me
```

## Tests

- `pnpm typecheck`
- `pnpm test`: Vitest in the Workers runtime (`@cloudflare/vitest-plugin`).
- `pnpm e2e`: Playwright. The web server step copies `.dev.vars.example` to `.dev.vars` if missing,
  resets `.wrangler/e2e`, applies local migrations and starts `wrangler dev` on 8787 with
  `MAX_MESSAGE_BYTES` lowered to 200000. Chromium is needed for the UI specs:
  `pnpm exec playwright install chromium`. `e2e/live.spec.ts` is skipped unless the `LIVE_*` variables are set.

## Cloudflare setup (needs the account owner)

Do these in order. Nothing here is automated.

1. **Domain.** Buy `flaky-tests.uk` at Cloudflare Registrar so DNS is already on Cloudflare. The bare
   domain gets no Worker route; mail to `*@flaky-tests.uk` itself is bounced.
2. **Email Routing.** Enable it for `ecom-staging.flaky-tests.uk` and `ecom-production.flaky-tests.uk`
   and add a catch-all rule "Send to Worker" (this Worker). Whether one catch-all covers both
   subdomains or each subdomain needs its own rule: _not yet recorded_. Write down what you found here.
3. **Storage and deploy.**
   ```sh
   pnpm exec wrangler d1 create flaky-inbox        # put the printed database_id in wrangler.toml
   pnpm exec wrangler r2 bucket create flaky-inbox-attachments   # private: no public access, no r2.dev URL
   pnpm exec wrangler d1 migrations apply flaky-inbox --remote
   pnpm exec wrangler secret put API_TOKENS        # see "API tokens"
   pnpm deploy
   ```
   `wrangler.toml` sets `workers_dev = false` and `preview_urls = false`. Check in the dashboard that
   the `workers.dev` route is off. Do the CPU measurement below before choosing the attachment cap.
4. **Custom domains.** Attach `mail-api.flaky-tests.uk` and `mailinat.flaky-tests.uk` to the Worker.
5. **Access.** In Zero Trust, create a self-hosted application for `mailinat.flaky-tests.uk` with an
   allow policy and one-time-code login; add your allowed addresses in the dashboard. Set the team
   domain and the application AUD on the Worker as the vars `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
   (dashboard or CI; they are not secret). The Worker verifies the `Cf-Access-Jwt-Assertion` header
   itself against `https://<team>.cloudflareaccess.com` certs and the AUD, and fails closed when
   either var is missing or the token is invalid. **Access service tokens are refused**: a JWT without
   an `email` claim gets no access, so the UI is for humans only.
6. **Real mail check.** Send a real mail with a real PDF, fetch it through the API and the UI and
   compare the SHA-256. Outcome: _not yet recorded_.

### API tokens

`API_TOKENS` is one Wrangler secret holding JSON, keyed by full mail domain, one or two tokens each:

```json
{"ecom-staging.flaky-tests.uk": ["<token>", "<token>"], "ecom-production.flaky-tests.uk": ["<token>"]}
```

Generate each token with `openssl rand -hex 32`. Send it as `Authorization: <token>` (no `Bearer `).
A token only works for its own domain; anything else is a 401. A domain with no token cannot be read.

Rotation (two tokens per domain allowed at once):

1. Generate a new token and `wrangler secret put API_TOKENS` with both old and new for that domain.
2. Switch CI and `.env.local` files to the new token.
3. `wrangler secret put API_TOKENS` again with only the new token.

### CI deploys

`.github/workflows/ci.yml` runs typecheck, unit tests and e2e on every push and PR, and deploys on
push to `main` (migrations, then `wrangler deploy`). Add the repository secrets `CLOUDFLARE_API_TOKEN`
(Workers, D1 and R2 edit rights) and `CLOUDFLARE_ACCOUNT_ID`. The `API_TOKENS` secret is set once with
`wrangler secret put` and is not touched by deploys.

### What happens when `email()` throws

Open item, check at deploy. Cloudflare's Email Workers runtime docs describe `setReject` (a permanent
SMTP rejection, so the sender gets a bounce) but say nothing about uncaught exceptions. Community
reports suggest Email Routing retries the Worker call a few times, then drops the mail, and that a
Worker cannot ask for a temporary failure. This is unconfirmed. The code only throws when the D1 write
fails (R2 objects are cleaned up first). To confirm: deploy a build that throws on a test address and
watch the sender's bounce and `wrangler tail`. Record the result here.

## CPU measurements

The free Workers plan allows about 10 ms CPU per call; this is the go/no-go for staying on it.

1. Generate samples (`tmp/` is gitignored): `pnpm cpu-sample` writes `cpu-sample-60k.eml`,
   `cpu-sample-1m.eml` and `cpu-sample-5m.eml` (a real Action invoice is about 60 KB).
2. After deploying (setup steps 1 to 4 at least for `ecom-staging`), send each file from a normal mail
   client, or with `curl` to a local instance, as a mail to `cpu-test@ecom-staging.flaky-tests.uk`.
3. Read CPU time per invocation from `pnpm exec wrangler tail --format json` (the `cpuTime` and
   `outcome` fields) or the Worker metrics in the dashboard.
4. Fill in the table. Set `MAX_ATTACHMENT_BYTES` in `wrangler.toml` to the largest size that stays
   inside the limit with headroom, and `MAX_MESSAGE_BYTES` to match (leave room for base64 overhead,
   about 4/3). If even the 60 KB sample exceeds the limit, stop and consider the 5 USD/month paid plan
   before paying for anything.

| Sample | PDF size | CPU ms | Outcome (`ok` / `exceededCpu`) |
|---|---|---|---|
| `cpu-sample-60k.eml` | 60 KB | | |
| `cpu-sample-1m.eml` | 1 MB | | |
| `cpu-sample-5m.eml` | 5 MB | | |

Chosen `MAX_ATTACHMENT_BYTES` / `MAX_MESSAGE_BYTES`: ____

## Live acceptance gate

`docs/acceptance.md` is the checklist, run against the deployed service with `e2e/live.spec.ts`.
Run that spec **alone**: the Mailinator helper reads `MAILINATOR_API_BASE_URL` once at import, so if
another spec in the same worker imported it first, the live spec silently hits `127.0.0.1`.

```sh
LIVE_API_BASE=https://mail-api.flaky-tests.uk/api/v2 LIVE_DOMAIN=ecom-staging.flaky-tests.uk \
MAILINATOR_API_KEY=<staging token> LIVE_INBOX=<inbox> LIVE_LINK_PREFIX=<url prefix> [LIVE_EXPECT_PDF=1] \
pnpm e2e live.spec.ts
```

**No change is made in `action/web` until every item in `docs/acceptance.md` is ticked.**

## Pointing `action/web` at the service

Separate piece of work, only after the acceptance gate. In `action/web`:

- Set `testConfig.mailinator.apiBaseUrl` to `https://mail-api.flaky-tests.uk/api/v2`.
- Set `testConfig.mailinator.domain` to the right mail subdomain per environment.
- Set `MAILINATOR_API_KEY` to the staging token for staging runs and the production token for
  production runs, and switch any hard-coded `ecomstaging.testinator.email` addresses.
- Add `getAttachments` and `downloadAttachment` to the helper when tests need PDFs
  (`.../messages/{id}/attachments` and `.../attachments/{attachmentId}`).
