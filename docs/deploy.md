# Deploying flaky-inbox from scratch

Step-by-step runbook for setting the service up on a personal Cloudflare account (free plan, no
bills). It was written while doing the first real deployment, so it describes the dashboard as it
looked on 2026-10-28, including the places where it did not behave the way the docs suggest. If a
screen has moved again, update this file.

Do the steps in order. Run all commands from the repo root (`~/Personal/github/flaky-inbox`).
GitHub steps use plain `git` and the browser; the `gh` CLI is not needed.

Never write tokens, personal email addresses or the Cloudflare account ID into this file: the repo is
public.

## Progress of the first deployment

| # | Step | Status |
|---|---|---|
| 1 | Push the repo to GitHub | done |
| 2 | Add the domain to Cloudflare | done |
| 3 | Enable R2, create D1 and R2, apply migrations | done |
| 4 | API tokens secret | done |
| 5 | Deploy the Worker | done |
| 6 | Custom domains for API and UI | done |
| 7 | Email Routing | done |
| 8 | Check the API by hand | done |
| 9 | Cloudflare Access for the UI | in progress |
| 10 | CPU measurement | not started |
| 11 | CI deploys | not started |
| 12 | Live acceptance (`docs/acceptance.md`) | not started |

## Before you start

- Node 24 and pnpm (the repo pins pnpm through `packageManager`; `corepack enable` if `pnpm` is missing).
- `pnpm install`, then `pnpm test` should pass.
- A Cloudflare account. Log Wrangler in once: `pnpm exec wrangler login` (opens the browser).
- A password manager entry ready for the two API tokens.

## 1. Push the repo to GitHub

1. On github.com, click **New repository**. Name it `flaky-inbox`, make it **Public**, and do not
   add a README, licence or .gitignore (the repo already has them).
2. Push:
   ```sh
   git remote add origin git@github.com:<your-user>/flaky-inbox.git
   git push -u origin main
   ```

## 2. Add the domain to Cloudflare

If the domain was bought at Cloudflare Registrar it is already a zone; check under **Domains** and
skip to step 3. Otherwise:

1. **Domains → Onboard a domain**. Enter the bare domain `flaky-tests.uk` (not a subdomain). Keep
   the quick DNS scan on.
2. Choose the **Free** plan.
3. In the DNS review, delete parking `A`/`CNAME` records and any `MX` records from the registrar.
   Email Routing adds its own MX records later.
4. Cloudflare shows two nameservers. At the registrar: turn **DNSSEC off** first if it is on, then
   replace the nameservers with Cloudflare's two.
5. Click **Check nameservers now** and wait until the zone shows **Active** (minutes to an hour,
   sometimes longer for `.uk`). Cloudflare emails you when it is.

Gotcha: adding a custom domain to the Worker before this is done gives "No zones match
mail-api.flaky-tests.uk" and an **Onboard domain** button. That button means "add the zone first";
do it for the bare domain as above.

## 3. Storage: R2, D1 and migrations

1. **Enable R2 first.** In the dashboard, **Storage & databases → R2**, click **Purchase R2 plan**
   and add a payment method. The free tier covers this service (10 GB, plenty of operations); it is
   not charged unless you go over. Without this, `wrangler r2 bucket create` fails.
2. Create the database and put its id in `wrangler.toml`:
   ```sh
   pnpm exec wrangler d1 create flaky-inbox
   ```
   Copy the printed `database_id` over the `00000000-…` placeholder in `wrangler.toml`. Forgot it?
   `pnpm exec wrangler d1 list` shows it again.
3. Create the bucket:
   ```sh
   pnpm exec wrangler r2 bucket create flaky-inbox-attachments
   ```
   Then in **R2 → flaky-inbox-attachments → Settings**: **Public Development URL** must say
   Disabled, and **Custom Domains** must be empty. The bucket stays private; the Worker serves files.
4. Create the tables:
   ```sh
   pnpm exec wrangler d1 migrations apply flaky-inbox --remote
   ```

## 4. API tokens

The Playwright tests prove who they are with a token sent as `Authorization: <token>` (no `Bearer`).
There is one token per mail domain, and a token only works for its own domain.

1. Generate two tokens, one for staging and one for production. Run this twice:
   ```sh
   openssl rand -hex 32
   ```
2. Save both in the password manager straight away (for example "flaky-inbox staging API token").
   Cloudflare never shows a secret again.
3. Build the secret value, one line of JSON, in an editor outside the repo:
   ```json
   {"ecom-staging.flaky-tests.uk":["<staging token>"],"ecom-production.flaky-tests.uk":["<production token>"]}
   ```
4. Store it. Prefer the interactive prompt, so the tokens do not land in shell history:
   ```sh
   pnpm exec wrangler secret put API_TOKENS
   ```
   Paste the JSON at `Enter a secret value:` (nothing shows while pasting) and press Enter.
   - If Wrangler says there is no Worker called `flaky-inbox` and offers to create one, say **yes**.
     The real code is deployed into it in step 5.
   - If you piped the value in with `echo` instead (Wrangler then prints "Using fallback value in
     non-interactive context"), delete that line from `~/.zsh_history` and run `fc -R`.
5. Check: `pnpm exec wrangler secret list` shows `API_TOKENS` (name only).

Broken JSON does not crash the Worker; every API call returns 401. Run `secret put` again to replace
it. Rotation is in the README under "API tokens".

## 5. Deploy the Worker

1. **Account workers.dev subdomain.** Open **Compute → Workers & Pages** in the dashboard once. The
   first visit gives the account a `<name>.workers.dev` subdomain. Without it the deploy uploads the
   code but fails on the cron trigger with:
   `You need a workers.dev subdomain in order to proceed ... [code: 10063]`.
   If opening the page is not enough: **flaky-inbox → Settings → Domains & Routes → workers.dev →
   Enable**, choose any subdomain name, and the next deploy switches it off again
   (`workers_dev = false` in `wrangler.toml`).
2. Deploy:
   ```sh
   pnpm run deploy
   ```
   Use `pnpm run deploy`, not `pnpm deploy` (that is a different, built-in pnpm command).
3. A good run lists the bindings (`env.DB`, `env.BUCKET` and the vars), ends with
   `schedule: 0 * * * *` and shows **no** `https://flaky-inbox.<you>.workers.dev` URL.
4. In **flaky-inbox → Settings → Domains & Routes**, `workers.dev` and **Preview URLs** must both be
   Disabled.

## 6. Custom domains

**Workers & Pages → flaky-inbox → Domains → Add Domain**, once for each:

- `mail-api.flaky-tests.uk` (the API the tests call)
- `mailinat.flaky-tests.uk` (the UI)

Cloudflare creates the DNS records and certificates itself. Each takes a minute or two to show Active.

## 7. Email Routing

1. **Email Routing → flaky-tests.uk**. Enable it if asked; Cloudflare adds MX, SPF and DKIM records
   for the bare domain (they show as Locked; leave them).
2. **Settings → Subdomains**: type `ecom-staging` in the box (it already ends in `.flaky-tests.uk`)
   and click **Add**. The Add button stays greyed out until something is typed. Repeat for
   `ecom-production`. Both should list their DNS records as added.
3. **Routing rules → Catch-all → Edit**: action **Send to a Worker**, destination **flaky-inbox**,
   save.
4. **Switch the catch-all on.** It is **off by default** after saving. While it is off, mail bounces
   with `550 5.1.1 Address does not exist`.

Verified on 2026-10-28: the one catch-all on the bare domain covers both subdomains. Cloudflare's
subdomain docs say subdomains only support literal address rules, but in practice no per-subdomain
rules were needed. Do not add plus-addressing or per-address rules.

Mail to the bare domain also reaches the Worker, which drops it and counts it as rejected.

## 8. Check the API by hand

Send a mail from any normal mailbox to `hello@ecom-staging.flaky-tests.uk`, then:

```sh
curl -s -H 'Authorization: <staging token>' \
  https://mail-api.flaky-tests.uk/api/v2/domains/ecom-staging.flaky-tests.uk/inboxes/hello
```

The reply is Mailinator-shaped: `{"domain": ..., "to": "hello", "msgs": [{ "id", "subject",
"origTo", "seconds_ago", ... }]}`. Then the same for production, with a mail to
`hi@ecom-production.flaky-tests.uk` and the production token.

Token isolation check (must print `401`):

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: <staging token>' \
  https://mail-api.flaky-tests.uk/api/v2/domains/ecom-production.flaky-tests.uk/inboxes/hi
```

Gotchas:
- If `msgs` is empty, check the `"to"` value in the reply. A stray character in the URL (we had
  `hi|`) silently queries a different, empty inbox.
- No mail at all: look for a bounce in the sender's mailbox, then **Email Routing → Activity log**.

## 9. Cloudflare Access for the UI

The UI at `mailinat.flaky-tests.uk` is for people only, behind Cloudflare Access with an emailed
one-time code. The allowed addresses live in the dashboard policy, never in this repo.

1. **Zero Trust** (left sidebar). The first visit creates a team with a random name (for example
   `something-something-1a2b`) on the **Zero Trust Free** plan. Keeping the random name is fine.
   The full team domain is under **Zero Trust → Settings → Team domain**:
   `<team>.cloudflareaccess.com`.
2. **Login method.** There is no "Settings → Authentication" any more; it is
   **Zero Trust → Integrations → Identity providers**. A fresh account may only list **Cloudflare**
   (log in with a Cloudflare account, restricted to account members). That is not enough for other
   people, so click **Add an identity provider → One-time PIN** and save. Nothing to fill in. Leave
   the Cloudflare entry as it is.
3. **Application.** **Access controls → Applications → Add an application → Self-hosted**:
   - Name `flaky-inbox UI`, domain `mailinat.flaky-tests.uk`, empty path.
   - Login methods: tick **One-time PIN** (optionally untick Cloudflare so there is one login screen).
   - Policy `QA team`, action **Allow**, Include rules (any one matches):
     **Emails ending in** `@action.nl`, plus an **Emails** rule for each personal address.
   - Save.
   - Where these are: in the Zero Trust sidebar, **Access controls** (expand it with `>`) →
     **Applications** → the blue **Add an application** / **Create new application** button →
     **Self-hosted** (may be called **Self-hosted and private**).
4. **AUD tag.** The dashboard is supposed to show the **Application Audience (AUD) Tag** on the
   application's Overview tab, but on 2026-10-28 it could not be found there. Reliable way: get it
   from the Access cookie.
   1. Open `https://mailinat.flaky-tests.uk` in a private window and log in with the emailed code.
      The page after login may show an error; that is fine, the Worker secrets are not set yet.
   2. DevTools → **Application** → **Cookies** → `https://mailinat.flaky-tests.uk`, copy the value
      of `CF_Authorization`.
   3. Decode it (for example at jwt.io; it is a short-lived login token for your own session). The
      `aud` field is the AUD tag: a 64-character hex string, sometimes shown inside `[ ]`; copy only
      the string.
5. **Worker secrets.** Store both as secrets, not dashboard variables (a deploy wipes dashboard
   variables):
   ```sh
   pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN   # <team>.cloudflareaccess.com, host only, no https://
   pnpm exec wrangler secret put ACCESS_AUD           # the AUD tag
   ```
6. Check in a private window: `https://mailinat.flaky-tests.uk` shows the Access login, an allowed
   address gets a code by email and then sees the inbox UI, and an address outside the policy is
   refused.

## 10. CPU measurement

The free plan allows about 10 ms CPU per call. Follow README, "CPU measurements": `pnpm cpu-sample`,
send the three sample mails to `cpu-test@ecom-staging.flaky-tests.uk`, read `cpuTime` from
`pnpm exec wrangler tail --format json`, fill in the table and set the attachment caps in
`wrangler.toml`.

## 11. CI deploys

1. Cloudflare: **Manage account → Account API tokens → Create token** with edit rights on Workers
   Scripts, D1 and Workers R2 Storage for this account. Copy the token and the account ID (shown on
   the account home page).
2. GitHub: **Settings → Secrets and variables → Actions**:
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
   - Variables: `DEPLOY_ENABLED` = `true`.
3. Push to `main` and check the Actions run: tests, then migrations and deploy.

CI never touches `API_TOKENS`, `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`.

## 12. Live acceptance

Work through `docs/acceptance.md` against the live service. No change goes into `action/web` until
every item there is ticked.
