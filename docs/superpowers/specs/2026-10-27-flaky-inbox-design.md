# flaky-inbox: design

Date: 2026-10-27
Status: approved 2026-10-28

## 1. What this is and why

A self-hosted replacement for the team's paid Mailinator plan (Verified Pro, about 9 EUR/month), built as one Cloudflare Worker.

The Action QA team's Playwright suite signs up throwaway users and reads the emails Action sends them (verification links today, order confirmations and invoice PDFs soon). Mailinator's plan caps reads at 60 per day, and the suite already goes over that on busy days (for example 132 reads on 2026-10-26). The replacement must:

1. Accept every inbound email for two mail subdomains (catch-all, any local part).
2. Serve those emails over an HTTP API that matches Mailinator's v2 API closely enough that the existing `MailinatorClient` helper in `action/web` works by changing only the base URL, the domain and the token.
3. Store PDF attachments and return them byte-for-byte, always tied to the right email.
4. Give the QA team a small web UI: browse inboxes, read a mail (HTML / TEXT / JSON / LINKS), download its PDFs, delete mails, and see usage statistics.

Success: the `action/web` Playwright suite runs green against this service with only config changes, the team uses the UI instead of Mailinator's, and the Mailinator subscription is cancelled. Running cost stays at the domain fee, or at most 5 USD/month if the Workers paid plan turns out to be needed (see section 11).

## 2. Goals, non-goals, anti-goals

**Goals**

- Drop-in replacement for the two API calls the helper makes (`getMessages`, `getLinks`), with identical behaviour for the fields the helper reads.
- Correct attachment-to-email binding, guaranteed by design and covered by tests.
- A login-protected UI for the QA team.
- Near-zero cost and near-zero maintenance.

**Non-goals**

- Sending email, SPF/DKIM/DMARC for sending.
- Public or shared inboxes, multi-team accounts, plan limits.
- Any processing of attachment contents (no text extraction, OCR or conversion).
- Non-PDF attachments, inline images, a RAW tab (the raw mail is not stored).
- Keeping mail long term. Everything expires.
- Changes to `action/web` (the helper's attachment methods and the config switch-over are a separate, later change; see section 12).

**Anti-goals (a failure even if it technically works)**

- Mail A's URL ever returning mail B's attachment, or staging mail visible under the production domain.
- Any page or file reachable without either the API token or a QA team login. Staging mail can contain real order data.
- Secrets, tokens, account ids or allowed-email rules committed to the public repo.
- Intermittent failures in the Playwright suite caused by this service (for example, links that break because `&amp;` was not decoded).

## 3. Names and hosts

Bare domain `flaky-tests.uk` is reserved for something else and gets no Worker route. It will carry the MX/SPF records Cloudflare Email Routing adds when it is enabled on the zone; the user confirmed that is fine because no mail is expected there. Mail to `*@flaky-tests.uk` itself has no rule and is bounced by Cloudflare. If the user later wants mail on the bare domain, a forwarding rule in Email Routing is the easy path; moving the bare domain to a full mail provider while keeping the subdomains on Email Routing is a known limit to check in Cloudflare's docs at that time.

| Host | Purpose | Protection |
|---|---|---|
| `ecom-staging.flaky-tests.uk` | Mail domain for tests against Action staging | n/a (inbound mail) |
| `ecom-production.flaky-tests.uk` | Mail domain for tests against Action production. Never receives real orders | n/a (inbound mail) |
| `mail-api.flaky-tests.uk` | API. Base URL `https://mail-api.flaky-tests.uk/api/v2` | Static API token |
| `mailinat.flaky-tests.uk` | Web UI | Cloudflare Access (email one-time code) |

All four are served by one Worker. The Worker tells the API and the UI apart by the request's `Host` header. A request to any other host gets 404.

Adding another mail subdomain later (say `ecom-acceptance`) means enabling Email Routing for it and adding it to `ALLOWED_DOMAINS`. No code change.

## 4. Architecture

```
Sender -> MX (Cloudflare Email Routing, catch-all per mail subdomain) -> Worker email()
            -> size guard -> postal-mime -> PDFs to R2 -> message + attachment rows to D1 (one batch)
            -> daily counters

Playwright -> mail-api.flaky-tests.uk/api/v2/... (Authorization: <token>) -> Worker fetch() -> D1 / R2
QA team    -> mailinat.flaky-tests.uk (Cloudflare Access login)      -> Worker fetch() -> D1 / R2

Cron (hourly) -> Worker scheduled() -> delete expired mail (R2 first, then D1), orphan sweep, old stats
```

- Runtime: one Cloudflare Worker in TypeScript with `email()`, `fetch()` and `scheduled()` handlers.
- Storage: D1 for messages, attachment metadata and stats. A private R2 bucket for attachment bytes.
- MIME parsing: `postal-mime`. Pick its attachment output mode (ArrayBuffer vs base64) that uses the least CPU and memory.
- Repo: `~/Personal/github/flaky-inbox`, a personal public GitHub repo.
- Cloudflare account: the user's **personal** account, not Action's. The aim is zero running cost. Moving to Action's account would need many people's sign-off and is out of scope.

**What a real Action order mail looks like** (checked from an Outlook copy of order 310000032543): `multipart/mixed` with a `multipart/alternative` text + HTML body and one attachment, `Content-Type: application/pdf; name="factuur-<n>.pdf"`, `Content-Disposition: attachment`, base64, about 80 KB encoded (about 60 KB PDF), starting with `%PDF-1.3`. The whole mail is about 140 KB. So invoices do arrive as real PDF attachments, and are small. The user saw no attachment in Mailinator's UI for these mails, which is one more reason to build this. The builder should get a test-address copy of such a mail (not the personal Outlook one, which contains real personal data) as a fixture, or build an equivalent synthetic one; nothing from a real order goes into the public repo.

## 5. Inbound mail (`email()`)

1. Check `message.rawSize` against `MAX_MESSAGE_BYTES` (default 10 MB). Too big: reject with `message.setReject(...)`, bump the `rejected` counter, store nothing.
2. Lowercase the recipient and split it at `@` into `inbox` and `domain`. A domain not in `ALLOWED_DOMAINS` is dropped (counted as `rejected` under domain `_other`).
3. Parse with `postal-mime`.
4. Generate the message id (UUID). Compute `received_at` (ms) and `expires_at = received_at + RETENTION_HOURS`.
5. Keep text and HTML bodies, each truncated to 1 MB (D1 caps a row at about 2 MB). Keep the headers as JSON.
6. Attachments:
   - Keep only PDFs: the first five bytes are `%PDF-` AND (the declared type is `application/pdf` OR the filename ends in `.pdf`). This is a header check, not parsing. Everything else is silently ignored. Inline `cid:` images are ignored too.
   - Keep at most `MAX_ATTACHMENTS` (default 10) PDFs, each at most `MAX_ATTACHMENT_BYTES` (default 5 MB). PDFs beyond these limits are ignored, and the message records how many were skipped.
   - For each kept PDF: generate an attachment id (UUID), compute SHA-256 with Web Crypto, and write the bytes unchanged to R2 under `{messageId}/{attachmentId}`.
7. Insert the message row and all attachment rows in one D1 batch (a single transaction).
8. Bump `incoming` for the domain.

**Failure rule (my call):** a mail is never lost because of an attachment problem, since a lost sign-up mail is a flaky test.
- R2 writes happen first, and the D1 batch is the commit point.
- If an R2 write fails, delete any objects already written for this message. Then store the message with **no** attachment rows and `attachments_incomplete = 1`. The API detail, the attachment list and the UI show this flag clearly, so nobody mistakes it for a mail without PDFs.
- If the D1 batch fails, delete the R2 objects and throw. The builder checks how Email Routing treats a thrown error (temporary failure with retry, or a bounce) and records it in the README.
- If the Worker dies between the R2 writes and the D1 batch, the orphan sweep (section 8) removes the stray objects.

## 6. API (`mail-api.flaky-tests.uk/api/v2`)

**Auth: one token per mail subdomain.** Every request must send `Authorization: <token>`, the bare token with no `Bearer ` prefix, exactly as the helper sends it today. `?token=` is not supported (the helper doesn't use it).
- Each mail subdomain has its own tokens. A staging token reads only `ecom-staging.flaky-tests.uk`, a production token reads only `ecom-production.flaky-tests.uk`. A leak exposes one side, and only that side's token needs replacing.
- Each domain accepts up to two tokens at once, so a token can be replaced without breaking test runs: add the new one, switch CI and `.env.local` files over, then remove the old one.
- The token is checked against the `{domain}` in the URL. A missing token, a wrong token, or a valid token for the other domain all get the same `401`. Compare in constant time.
- Tokens live in one Wrangler secret, `API_TOKENS`, holding JSON like `{"ecom-staging.flaky-tests.uk": ["<token>", "<token>"], "ecom-production.flaky-tests.uk": ["<token>"]}`. A domain in `ALLOWED_DOMAINS` with no token can't be read through the API. Generate tokens as at least 32 random bytes.

**Common rules**

- `{domain}` must be in `ALLOWED_DOMAINS`, otherwise 404. `{inbox}` is lowercased before lookup.
- Every read hides messages where `expires_at <= now`.
- Every lookup of a message checks that its `domain` and `inbox` match the URL. A mismatch is a 404 that looks exactly like "not found".

**Endpoints**

| Method and path | Used by the tests today | Returns |
|---|---|---|
| `GET /domains/{domain}/inboxes/{inbox}` | yes (`getMessages`) | `{ domain, to, msgs: [...] }`, newest first |
| `GET /domains/{domain}/inboxes/{inbox}/messages/{id}/links` | yes (`getLinks`) | `{ links: string[] }` |
| `GET /domains/{domain}/inboxes/{inbox}/messages/{id}` | no | message detail (Mailinator shape) |
| `GET /domains/{domain}/inboxes/{inbox}/messages/{id}/attachments` | no (new) | attachment metadata list |
| `GET /domains/{domain}/inboxes/{inbox}/messages/{id}/attachments/{attachmentId}` | no (new) | the PDF bytes |

There is no delete endpoint. Delete is UI-only.

**Inbox list.** An empty or unknown inbox returns `200 { domain, to: inbox, msgs: [] }`, never 404, so the helper's polling stays quiet. Each entry in `msgs`:

| Field | Meaning | Read by helper |
|---|---|---|
| `id` | message id (string) | yes |
| `subject` | subject | yes |
| `to` | inbox name | yes |
| `from` | sender display name, falling back to the address (Mailinator shows "Action.com") | yes |
| `seconds_ago` | whole seconds since `received_at`, computed at read time | yes (sorts on it) |
| `fromfull` | sender address | no |
| `origTo` | full recipient address | no |
| `time` | `received_at` in ms | no |

The builder checks Mailinator's current v2 docs for these field names and types and matches them exactly. Where the docs and this table disagree on a field the helper reads, the helper's code wins.

**Links.** Extract at read time from the stored bodies. First every `href` from the HTML body, with HTML entities decoded (`&amp;` becomes `&`), then every `http(s)://` URL found in the text body. Keep absolute `http`/`https` URLs only, drop duplicates, and keep first-seen order. The builder checks this against Mailinator's docs (for example, whether text-body URLs or `mailto:` are included) and follows Mailinator where it differs. Byte-exact URLs matter: the helper calls `startsWith` on the Gigya verification URL and then opens it.

**Message detail.** Follow Mailinator's v2 message shape (`id`, `subject`, `from`, `to`, `time`, `headers`, `parts: [{ headers, body }]`, and so on). Add an `attachments` list (`id`, `filename`, `contentType`, `size`, `sha256`) under whatever field name Mailinator uses, or `attachments` if it has none. The UI's JSON tab shows exactly this response.

**Attachment download.** Look up the attachment by id and confirm all of the following: its `message_id` equals `{id}`, that message's `domain` and `inbox` equal the URL's, and the message has not expired. Any mismatch returns 404. Stream the R2 object with:
- `Content-Type` as stored
- `Content-Length`
- `Content-Disposition: attachment; filename="<sanitized>"` (strip path separators, control characters and quotes; add `filename*` for non-ASCII)
- `X-Content-Type-Options: nosniff`

If the R2 object is missing, or its size differs from the stored size, return 500 and log it. Never return bytes that might be wrong.

**Errors:** JSON `{ error: "<message>" }` with the right status code.

## 7. Web UI (`mailinat.flaky-tests.uk`)

**Who gets in:** Cloudflare Access (Zero Trust free plan, up to 50 users) protects the whole hostname with an email one-time-code login. The allow policy is decided by the user: any `@action.nl` address, plus two named personal addresses belonging to the user. The policy lives only in the Cloudflare dashboard, and the personal addresses are never written into the repo. Note that this lets any Action employee with an `@action.nl` mailbox in, not only QA. Each person who logs in uses one of the 50 free seats. The Worker also verifies the `Cf-Access-Jwt-Assertion` header against the Access team's public keys and the application's AUD tag on every UI request. If that check fails or isn't configured, the request is refused (fail closed). For local development only, `UI_AUTH_MODE=dev` in `.dev.vars` skips the check. The deployed config is always `access`.

**How it's built (my call):** pages are rendered on the server by the same Worker, with a little plain JavaScript for auto-refresh, checkboxes and confirm dialogs. No frontend framework and no separate build. A small router (for example Hono with its JSX) is fine. UI pages read D1 directly through the same data layer as the API, not through the API itself.

**Pages** (layout modelled on the Mailinator UI the team already uses; see the mockup in the brainstorm session):

1. **Inbox view** (`/`)
   - Domain dropdown (`ecom-staging`, `ecom-production`, from `ALLOWED_DOMAINS`) and an inbox filter box. An empty filter shows every inbox on the domain. The filter matches an inbox name prefix.
   - Table: checkbox, To (inbox), From (display name), Subject, number of PDFs, Received ("20 min", "2 hours"). Newest first, 50 per page with next/previous. Each row links to the message page.
   - Auto-refresh every 10 seconds while the page is visible. The refresh must not clear ticked checkboxes.
   - Checkbox per row, "select all on this page", and a **Delete selected** button with a confirm dialog ("Delete 3 mails and their attachments?").
2. **Message page** (`/m/{domain}/{inbox}/{id}`)
   - Header: To (full address), From (address), Received, Expires.
   - Attachments box: one row per PDF with filename, size, short SHA-256 and a Download button. Two files with the same name appear as two rows.
   - Tabs: **HTML** (the body inside a sandboxed `iframe srcdoc` with no `allow-scripts`, so no script runs. Remote images may load), **TEXT** (plain text body), **JSON** (the API's message-detail response), **LINKS** (the API's links list, each one clickable).
   - **Delete** button with a confirm dialog.
3. **Statistics** (`/stats`), described in section 9.

Downloads in the UI go through a UI route with the same integrity checks as the API download.

**Delete:** a POST from the UI. Remove the R2 objects first, then the attachment rows, then the message row, the same order as cleanup. Reject the POST unless its `Origin` header is `https://mailinat.flaky-tests.uk` (cross-site request protection). Deleted mail still counts in that day's `incoming`.

## 8. Retention and cleanup

- `RETENTION_HOURS` defaults to 72 (3 days, the user's choice for now). It's one setting covering mail and attachments on every domain, and can be raised later without code changes.
- `expires_at` is fixed at ingest. Changing the setting affects only new mail. Reads hide expired mail immediately.
- An hourly Cron Trigger runs `scheduled()`:
  1. For each expired message, in batches: delete its R2 objects, then its attachment rows, then the message row.
  2. Orphan sweep: list R2 objects older than one hour whose message id has no row, and delete them.
  3. Delete stats rows older than `STATS_RETENTION_DAYS` (default 90).
- Optional backstop (builder's choice): an R2 lifecycle rule that expires objects after `RETENTION_HOURS` + 1 day.

## 9. Statistics

The stats page shows one row per day, newest first, for the last 90 days. A domain dropdown offers `ecom-staging`, `ecom-production` or "all".

| Column group | Counter | Counted when |
|---|---|---|
| Emails incoming | `incoming` | a mail is stored |
| | `rejected` | a mail is dropped for size or unknown domain |
| Emails accessed | `accessed_api` | an API call to message detail, links, attachment list or attachment download succeeds |
| | `accessed_ui` | a UI message page view or attachment download |
| API calls | `api_inbox`, `api_message`, `api_attachment` | every API request, by endpoint type (`api_message` covers detail and links) |
| | `api_error` | every API response with status 400 or higher, including 401 |

Storage: a `daily_stats (day TEXT, domain TEXT, metric TEXT, count INTEGER, PRIMARY KEY (day, domain, metric))` table, bumped with an upsert as events happen. API requests whose domain is unknown or missing are counted under `_other`. Counting must never break a request: if the upsert fails, log it and carry on. Days are UTC.

Plan limits, "overlimit", SMS and webhooks are left out.

## 10. Data model (starting point)

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  inbox TEXT NOT NULL,
  from_name TEXT,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  headers_json TEXT,
  text_body TEXT,
  html_body TEXT,
  skipped_attachments INTEGER NOT NULL DEFAULT 0,
  attachments_incomplete INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_inbox ON messages (domain, inbox, received_at DESC);
CREATE INDEX idx_domain_time ON messages (domain, received_at DESC);
CREATE INDEX idx_expires ON messages (expires_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  filename TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL
);
CREATE INDEX idx_att_message ON attachments (message_id);

CREATE TABLE daily_stats (
  day TEXT NOT NULL,
  domain TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, domain, metric)
);
```

The builder may adjust the schema. Use migrations (`wrangler d1 migrations`).

## 11. Config, secrets and cost

Variables (`wrangler.toml`):
- `ALLOWED_DOMAINS`: comma-separated full mail hostnames (for example `ecom-staging.flaky-tests.uk`), because the helper puts the full hostname in both the address and the API path. Local default `test.example`.
- `API_HOST`, `UI_HOST`: the two hostnames.
- `RETENTION_HOURS` (72), `STATS_RETENTION_DAYS` (90)
- `MAX_MESSAGE_BYTES` (10 MB), `MAX_ATTACHMENTS` (10), `MAX_ATTACHMENT_BYTES` (5 MB), `MAX_BODY_BYTES` (1 MB)
- `UI_AUTH_MODE` (`access`; `dev` only in `.dev.vars`)
- `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`: not secret, but set them in the dashboard or CI rather than committing them if you'd rather keep them out of the public repo

Secrets: `API_TOKENS` (Wrangler secret, one or two tokens per mail subdomain, see section 6), plus a Cloudflare API token for CI deploys (GitHub secret).

No side doors: set `workers_dev = false` and turn off preview URLs in `wrangler.toml`, so the Worker answers only on its custom hostnames and the email route. The Worker still refuses any `Host` other than `API_HOST` and `UI_HOST`. Bindings: D1 database and R2 bucket. The R2 bucket is private, with no public access and no `r2.dev` URL.

The public repo contains no tokens, no account ids, no allowed-email rules and no real mail. Test fixtures use made-up mails and a generated sample PDF.

Cost: the goal is zero running cost on the user's personal Cloudflare account; the domain fee is the only fixed cost. Workers, D1, R2 and Access all fit their free tiers at this volume (roughly 20 to 70 mails a day, a few hundred API calls). Cloudflare may ask for a payment method when activating the free Zero Trust (Access) plan or R2; that is not a charge. The one risk is CPU time on the free Workers plan (about 10 ms per call) when parsing a mail and decoding its PDF. Real Action invoices are about 60 KB, so this is likely fine, but measure early with a mail of that shape. If the limit is exceeded, the fallback is the Workers paid plan at 5 USD/month; raise it with the user before paying.

## 12. Testing

- **Unit tests** (Vitest with the Cloudflare Workers pool): link extraction (entity decoding, dedupe, order), filename sanitising, the PDF check, the Access JWT check, the stats upsert.
- **API end-to-end tests** (Playwright, TypeScript) against `wrangler dev` with local D1/R2, delivering mails through the local email-handler endpoint:
  - A mail with a PDF: list, detail and download work, and the downloaded SHA-256 equals the original's.
  - Two mails with different PDFs in one inbox: each URL returns only its own file.
  - Mail A's attachment id under mail B's URL returns 404. The wrong domain or inbox returns 404.
  - Two `invoice.pdf` files in one mail are both stored, distinct and downloadable.
  - A missing or wrong token returns 401. A `Bearer <token>` value also returns 401, so the helper's format is the one that's tested.
  - A staging token used on the production domain returns 401, and so does the reverse. Both of a domain's two tokens work.
  - Links come back from the right message, from both the HTML and text bodies, with `&amp;` decoded.
  - An empty inbox returns 200 with `msgs: []`.
  - Expired mail is hidden on read, and cleanup removes both its D1 rows and its R2 objects.
  - An oversize mail is rejected with nothing left behind. Non-PDF attachments are ignored.
  - Stats counters move as expected.
- **Helper compatibility test:** copy the `MailinatorClient` from `action/web` (`tests/core/helpers/...`) into this repo's tests unchanged, and run its `getMessages`, `getLinks` and `waitForLinkStartingWith` against the local service.
- **UI tests** (Playwright, with `UI_AUTH_MODE=dev`): inbox view and filter, message tabs, download, delete with confirm, the stats page. Plus one test that the UI refuses requests in `access` mode without a valid assertion.

## 13. Build order

1. Scaffold: Worker, TypeScript, `postal-mime`, D1 and R2 bindings, migrations, local dev.
2. CPU spike: ingest an Action-shaped invoice mail (about 140 KB with a 60 KB PDF, see section 4) on a deployed free-plan Worker and record CPU time. Also try a 1 MB and a 5 MB PDF to see where the free limit bites, and set `MAX_ATTACHMENT_BYTES` from that.
3. Data layer, then `email()` with the integrity rules.
4. API endpoints and token auth, with the API tests and the helper-compatibility test.
5. `scheduled()` cleanup and orphan sweep.
6. Stats counters.
7. UI: Access check, inbox view, message page, delete, stats page, UI tests.
8. README: Cloudflare setup, deploy, and how to point `action/web` at the service.
9. Optional: a GitHub Actions workflow that runs the tests and deploys on push to `main`.

## 14. Deployment checklist (needs the user)

1. Buy `flaky-tests.uk` at Cloudflare Registrar on the user's personal Cloudflare account, so DNS is already on Cloudflare.
2. Email Routing: enable it for `ecom-staging.flaky-tests.uk` and `ecom-production.flaky-tests.uk`, and add a catch-all rule "Send to Worker". The builder checks whether one catch-all covers both subdomains or each needs its own rule.
3. Create the D1 database and the private R2 bucket, run migrations, set `API_TOKENS` (one token per mail subdomain), and deploy. Check the dashboard shows the `workers.dev` route turned off.
4. Attach the custom domains `mail-api.flaky-tests.uk` and `mailinat.flaky-tests.uk` to the Worker.
5. Zero Trust: create an Access application for `mailinat.flaky-tests.uk` with an allow policy for emails ending in `@action.nl` plus the user's two personal addresses, then copy the team domain and AUD into the Worker config.
6. Send a real mail with a real PDF, then fetch it through the API and the UI and compare checksums.

## 15. Follow-up outside this repo (not part of this build)

In `action/web`:
- Point `testConfig.mailinator.apiBaseUrl` at `https://mail-api.flaky-tests.uk/api/v2`.
- Point `testConfig.mailinator.domain` at the right mail subdomain per environment.
- Set `MAILINATOR_API_KEY` to the staging token for staging runs and the production token for production runs, then switch any hard-coded `ecomstaging.testinator.email` addresses.
- Add `getAttachments` and `downloadAttachment` to the helper when tests need PDFs.

## 16. Calls made without the user (check these)

- One Worker serves the API and UI on two hostnames. The user then chose one token per mail subdomain, two tokens allowed during a swap, and `workers.dev` turned off.
- R2 writes first, then one D1 batch as the commit point (the handover suggested inserting the message row first). If R2 fails, the mail is still stored, flagged `attachments_incomplete`, so a mail is never lost over a PDF.
- PDF check: `%PDF-` magic bytes plus either a PDF content type or a `.pdf` name. Per-attachment cap of 5 MB.
- The inbox list returns 200 with `msgs: []` for an unknown inbox.
- Links: HTML hrefs (entity-decoded), then text-body URLs, `http(s)` only, deduplicated. To be checked against Mailinator.
- UI: server-rendered, no frontend framework, 10-second auto-refresh, 50 per page, filter by inbox prefix.
- The UI verifies the Access JWT itself and fails closed. Local dev uses `UI_AUTH_MODE=dev`.
- Delete is UI-only, with no API endpoint.
- Stats are kept 90 days, include `rejected` and `api_error`, and use UTC days.
- No RAW tab, no pause button, inline images ignored.
