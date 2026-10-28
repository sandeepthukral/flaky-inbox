# flaky-inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Cloudflare Worker that receives catch-all mail for two subdomains, stores bodies in D1 and PDF attachments in R2, serves a Mailinator-v2-compatible API, and a login-protected web UI with stats.

**Architecture:** A single Worker with `email()`, `fetch()` and `scheduled()` handlers. `fetch()` dispatches on the `Host` header to two Hono apps (API and UI) that share one data layer. All business logic takes `now: number` and its storage handles as parameters, so retention, failure and integrity rules are tested in-process with Vitest; Playwright covers the HTTP surface end to end against `wrangler dev`.

**Tech Stack:** TypeScript (strict), pnpm, Node 22+, Wrangler 4, Hono (routing + JSX for server-rendered HTML), `postal-mime`, `jose` (Access JWT), Vitest + `@cloudflare/vitest-pool-workers`, Playwright, `pdf-lib` (dev-only, generates test PDFs), `mimetext` or a hand-rolled builder (dev-only, builds test mails).

**Spec:** `docs/superpowers/specs/2026-10-27-flaky-inbox-design.md`. Read it before any task; section numbers below refer to it.

## Global Constraints

- Hosts: API `mail-api.flaky-tests.uk` (base path `/api/v2`), UI `mailinat.flaky-tests.uk`, mail domains `ecom-staging.flaky-tests.uk`, `ecom-production.flaky-tests.uk`. Any other `Host` → 404.
- Defaults: `RETENTION_HOURS=72`, `STATS_RETENTION_DAYS=90`, `MAX_MESSAGE_BYTES=10485760`, `MAX_ATTACHMENTS=10`, `MAX_ATTACHMENT_BYTES=5242880`, `MAX_BODY_BYTES=1048576`, `UI_AUTH_MODE=access`.
- `wrangler.toml`: `workers_dev = false`, `preview_urls = false`, hourly cron `0 * * * *`.
- API auth: bare token in `Authorization` (no `Bearer`); per-domain tokens from secret `API_TOKENS` (JSON `Record<domain, string[]>`, max two per domain); constant-time compare; every auth failure → identical `401`.
- R2 key: `{messageId}/{attachmentId}`, both `crypto.randomUUID()`. Never derive keys or paths from sender data.
- Bytes are never re-encoded: downloaded SHA-256 equals the original attachment's.
- Delete order everywhere: R2 objects → `attachments` rows → `messages` row.
- Expired (`expires_at <= now`) mail is invisible on every read path, API and UI.
- Nothing secret or personal in the public repo: no tokens, account ids, Access policy emails, or real mail. Fixtures are synthetic. `.dev.vars` is gitignored; commit `.dev.vars.example` instead.
- Stats counting never fails a request: catch, `console.error`, continue. Days are UTC `YYYY-MM-DD`. Unknown domain → `_other`.
- Error responses on the API: JSON `{ "error": "<message>" }`.

## Review Focus

1. **Recipient casing and plus-addressing** — mail to `AutoUser+1@ECOM-STAGING.flaky-tests.uk` must list under inbox `autouser+1`, and `GET .../inboxes/AutoUser+1` must find it. Test added to Task 4 and Task 6.
2. **Envelope vs header recipient** — when the `To:` header differs from the SMTP envelope recipient (BCC, list mail), the mail belongs to the envelope recipient (`message.to`). Test added to Task 4.
3. **Missing parts** — a mail with no subject, no HTML body, or no text body must list, render and return `links: []` without throwing. Tests added to Task 5 and Task 6.
4. **Quoted-printable HTML** — a verification URL split by `=\r\n` soft breaks and containing `=3D` must come back from `/links` byte-exact. Test added to Task 5 (via `postal-mime`-decoded fixture in Task 4's builder).
5. **Awkward attachment names** — missing filename, non-ASCII (`factuur €.pdf`), and names with `../`, quotes or CR/LF must produce a valid `Content-Disposition` and a safe download. Tests added to Task 3 and Task 7.

---

## File Structure

```
wrangler.toml                     bindings, vars, cron, workers_dev=false
.dev.vars.example                 local secrets/vars template (real .dev.vars gitignored)
migrations/0001_init.sql          schema from spec §10
src/index.ts                      default export {email, fetch, scheduled}; Host dispatch
src/env.ts                        Env interface (bindings + raw vars)
src/config.ts                     parseConfig(env) -> Config
src/time.ts                       utcDay(now), relativeAge(ms)
src/db/messages.ts                message/attachment queries + deleteMessages
src/db/stats.ts                   bumpStat, readStats, purgeOldStats
src/ingest/pdf.ts                 isAcceptedPdf
src/ingest/ingest.ts              ingestEmail (all of spec §5)
src/links.ts                      extractLinks
src/filename.ts                   sanitizeFilename, contentDisposition
src/attachments.ts                serveAttachment (shared by API and UI)
src/shapes.ts                     toInboxEntry, toMessageDetail (Mailinator JSON)
src/api/auth.ts                   isTokenValid, parseApiTokens
src/api/app.ts                    Hono app for API host
src/ui/access.ts                  verifyAccessJwt
src/ui/app.tsx                    Hono app for UI host (routes + middleware)
src/ui/layout.tsx                 shared page chrome + nav
src/ui/inbox.tsx                  inbox page + rows fragment
src/ui/message.tsx                message page
src/ui/stats.tsx                  stats page
src/ui/client.ts                  inline script string: refresh, checkboxes, confirm, tabs
src/cleanup.ts                    runCleanup
test/                             Vitest (workers pool)
  setup.ts                        apply D1 migrations
  mail-builder.ts                 buildMail(opts) -> raw MIME string; makePdf()
  *.test.ts
e2e/                              Playwright against wrangler dev
  playwright.config.ts
  deliver.ts                      deliverMail(raw, from, to) via local email handler
  mailinator-client.ts            copy of action/web helper (imports adapted only)
  *.spec.ts
README.md
.github/workflows/ci.yml
```

---

### Task 1: Scaffold, config, schema, host dispatch

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `.gitignore`, `.dev.vars.example`, `vitest.config.ts`, `migrations/0001_init.sql`, `src/env.ts`, `src/config.ts`, `src/index.ts`, `test/setup.ts`
- Test: `test/config.test.ts`, `test/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `interface Env { DB: D1Database; BUCKET: R2Bucket; ALLOWED_DOMAINS: string; API_HOST: string; UI_HOST: string; UI_ORIGIN: string; RETENTION_HOURS: string; STATS_RETENTION_DAYS: string; MAX_MESSAGE_BYTES: string; MAX_ATTACHMENTS: string; MAX_ATTACHMENT_BYTES: string; MAX_BODY_BYTES: string; UI_AUTH_MODE: string; ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; API_TOKENS: string }`
  - `type Config = { allowedDomains: string[]; apiHost: string; uiHost: string; uiOrigin: string; retentionMs: number; statsRetentionDays: number; maxMessageBytes: number; maxAttachments: number; maxAttachmentBytes: number; maxBodyBytes: number; uiAuthMode: 'access' | 'dev'; accessTeamDomain?: string; accessAud?: string; apiTokens: Record<string, string[]> }`
  - `parseConfig(env: Env): Config` in `src/config.ts` — domains lowercased and trimmed; numbers parsed with defaults from Global Constraints; any `UI_AUTH_MODE` other than exactly `dev` becomes `access`; `apiTokens` via `parseApiTokens` (Task 6 defines it — in this task, inline a minimal `JSON.parse` that Task 6 replaces).
  - `src/index.ts` default export `{ email, fetch, scheduled }`; `fetch` compares `new URL(req.url).host` (host incl. port) to `cfg.apiHost` / `cfg.uiHost`; neither → `404`. Handlers for email/scheduled and the two apps are stubs returning 501 until later tasks.

Local dev hosts (my call, so one `wrangler dev` serves both sides without DNS tricks): `.dev.vars.example` sets `API_HOST=127.0.0.1:8787`, `UI_HOST=localhost:8787`, `UI_ORIGIN=http://localhost:8787`, `ALLOWED_DOMAINS=staging.test.example,prod.test.example`, `UI_AUTH_MODE=dev`, `API_TOKENS={"staging.test.example":["stage-token-a","stage-token-b"],"prod.test.example":["prod-token"]}`. Production `wrangler.toml` sets `UI_ORIGIN=https://mailinat.flaky-tests.uk`.

- [ ] **Step 1: Scaffold.** `pnpm init`; add deps `hono postal-mime jose`; dev deps `wrangler typescript vitest @cloudflare/vitest-pool-workers @cloudflare/workers-types @playwright/test pdf-lib`. Scripts: `dev` (`wrangler dev`), `test` (`vitest run`), `e2e` (`playwright test -c e2e/playwright.config.ts`), `typecheck` (`tsc --noEmit`), `deploy` (`wrangler deploy`). Write `wrangler.toml` with D1 binding `DB` (database_name `flaky-inbox`), R2 binding `BUCKET` (bucket `flaky-inbox-attachments`), `[triggers] crons = ["0 * * * *"]`, `workers_dev = false`, `preview_urls = false`, `[vars]` for every non-secret in Global Constraints with production hostnames. Leave `database_id` as a placeholder comment; the user fills it at deploy (Task 14). `.gitignore`: `node_modules`, `.wrangler`, `.dev.vars`, `test-results`, `playwright-report`.
- [ ] **Step 2: Write `migrations/0001_init.sql`** exactly as spec §10.
- [ ] **Step 3: Configure Vitest** with `defineWorkersConfig`, `wrangler.configPath: './wrangler.toml'`, miniflare bindings overriding vars to the local-dev values above, and `test/setup.ts` calling `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` (read migrations in config via `readD1Migrations`).
- [ ] **Step 4: Write failing tests.**

```ts
// test/config.test.ts
it('parses defaults and lowercases domains', () => {
  const cfg = parseConfig({ ...baseEnv, ALLOWED_DOMAINS: ' Staging.Test.Example ,prod.test.example', RETENTION_HOURS: '' } as Env);
  expect(cfg.allowedDomains).toEqual(['staging.test.example', 'prod.test.example']);
  expect(cfg.retentionMs).toBe(72 * 3_600_000);
  expect(cfg.maxAttachmentBytes).toBe(5_242_880);
});
it('fails closed on unknown auth mode', () => {
  expect(parseConfig({ ...baseEnv, UI_AUTH_MODE: 'DEV ' } as Env).uiAuthMode).toBe('access');
});
// test/dispatch.test.ts (uses SELF from cloudflare:test)
it('404s an unknown host', async () => {
  const res = await SELF.fetch('http://evil.example/api/v2/domains/x/inboxes/y');
  expect(res.status).toBe(404);
});
```

- [ ] **Step 5: Run** `pnpm test` → FAIL (modules missing).
- [ ] **Step 6: Implement** `src/env.ts`, `src/config.ts`, `src/index.ts` per Interfaces.
- [ ] **Step 7: Run** `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 8: Commit** `chore: scaffold worker, config, schema and host dispatch`.

---

### Task 2: Data layer and stats counters

**Files:**
- Create: `src/time.ts`, `src/db/messages.ts`, `src/db/stats.ts`
- Test: `test/db.test.ts`, `test/stats.test.ts`

**Interfaces:**
- Consumes: `Env`, `Config` (Task 1).
- Produces:
  - `utcDay(now: number): string` → `'2026-10-28'`; `relativeAge(ms: number): string` → `'just now' | 'N min' | 'N hours' | 'N days'` (used by UI).
  - `type MessageRow = { id; domain; inbox; from_name: string | null; from_addr; to_addr; subject: string | null; headers_json: string | null; text_body: string | null; html_body: string | null; skipped_attachments: number; attachments_incomplete: number; received_at: number; expires_at: number }`
  - `type AttachmentRow = { id; message_id; filename: string | null; content_type; size: number; sha256: string; r2_key: string }`
  - `type MessageSummary = Pick<MessageRow, 'id'|'domain'|'inbox'|'from_name'|'from_addr'|'to_addr'|'subject'|'received_at'|'expires_at'> & { attachment_count: number }`
  - `insertMessage(db: D1Database, msg: MessageRow, atts: AttachmentRow[]): Promise<void>` — one `db.batch`.
  - `listMessages(db, q: { domain: string; inbox?: string; inboxPrefix?: string; now: number; limit: number; offset: number }): Promise<{ rows: MessageSummary[]; total: number }>` — newest first; `inbox` = exact match, `inboxPrefix` = `LIKE prefix || '%'` with `%`/`_` escaped.
  - `getMessage(db, domain: string, inbox: string, id: string, now: number): Promise<MessageRow | null>` — all four must match and not expired.
  - `listAttachments(db, messageId: string): Promise<AttachmentRow[]>` — ordered by insertion (add `rowid` order).
  - `getAttachmentForMessage(db, domain, inbox, messageId, attachmentId, now): Promise<AttachmentRow | null>` — **one** JOIN query enforcing `a.id = ? AND a.message_id = ? AND m.domain = ? AND m.inbox = ? AND m.expires_at > ?`.
  - `deleteMessages(env: Pick<Env,'DB'|'BUCKET'>, ids: string[]): Promise<number>` — for the ids: collect `r2_key`s, `BUCKET.delete(keys)` (chunks of 1000), then batch delete attachments then messages; returns messages deleted.
  - `listExpiredIds(db, now: number, limit: number): Promise<string[]>`
  - `type Metric = 'incoming'|'rejected'|'accessed_api'|'accessed_ui'|'api_inbox'|'api_message'|'api_attachment'|'api_error'`
  - `bumpStat(db, domain: string, metric: Metric, now: number): Promise<void>` — `INSERT ... ON CONFLICT(day,domain,metric) DO UPDATE SET count = count + 1`; never throws.
  - `readStats(db, q: { domain: string | 'all'; now: number; days: number }): Promise<Array<{ day: string } & Record<Metric, number>>>` — newest day first, zero-filled for metrics, only days with any row.
  - `purgeOldStats(db, now: number, days: number): Promise<void>`

- [ ] **Step 1: Write failing tests** in `test/db.test.ts`:
  - `getMessage returns null for wrong domain, wrong inbox, or expired` (insert one row; assert each mismatch → `null`, exact → row).
  - `listMessages hides expired and orders newest first`.
  - `listMessages inboxPrefix treats % and _ literally` (inboxes `a_b`, `axb`; prefix `a_` returns only `a_b`).
  - `getAttachmentForMessage enforces message, domain, inbox and expiry` (two messages A and B each with one attachment; A's attachment id with B's message id → `null`; with A's id but other domain → `null`).
  - `deleteMessages removes R2 objects, attachments and message` (put object at key, call, assert `BUCKET.head(key)` is `null` and both tables empty).
  In `test/stats.test.ts`: `bumpStat increments per day/domain/metric`; `bumpStat swallows errors` (pass a `db` whose `prepare` throws; expect no rejection); `readStats sums across domains for 'all'`; `utcDay uses UTC` (`utcDay(Date.UTC(2026,9,27,23,30))` → `'2026-10-27'`).
- [ ] **Step 2: Run** `pnpm test test/db.test.ts test/stats.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/time.ts`, `src/db/messages.ts`, `src/db/stats.ts` per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: data layer and daily stats counters`.

---

### Task 3: Pure helpers — PDF check, filenames

**Files:**
- Create: `src/ingest/pdf.ts`, `src/filename.ts`
- Test: `test/pdf.test.ts`, `test/filename.test.ts`

**Interfaces:**
- Produces:
  - `isAcceptedPdf(bytes: Uint8Array, contentType: string | undefined, filename: string | undefined): boolean` — first 5 bytes are `%PDF-` AND (`contentType` lowercased, params stripped, `=== 'application/pdf'` OR `filename` lowercased ends with `.pdf`).
  - `sanitizeFilename(name: string | null | undefined): string` — take basename after last `/` or `\`; remove control chars (U+0000–U+001F, U+007F), `"`, `\`; collapse whitespace; trim dots/spaces; max 150 chars; empty → `attachment.pdf`.
  - `contentDisposition(name: string | null | undefined): string` — `attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>`; ASCII fallback replaces non-ASCII with `_`.

- [ ] **Step 1: Write failing tests.**

```ts
const pdf = new TextEncoder().encode('%PDF-1.3\n...');
it('accepts magic + type', () => expect(isAcceptedPdf(pdf, 'application/pdf; name="x"', undefined)).toBe(true));
it('accepts magic + .pdf name with octet-stream', () => expect(isAcceptedPdf(pdf, 'application/octet-stream', 'F.PDF')).toBe(true));
it('rejects pdf type without magic', () => expect(isAcceptedPdf(new TextEncoder().encode('<html>'), 'application/pdf', 'a.pdf')).toBe(false));
it('rejects magic with image type and no .pdf name', () => expect(isAcceptedPdf(pdf, 'image/png', 'a.png')).toBe(false));

it('strips paths and control chars', () => expect(sanitizeFilename('../../etc/pa"ss\r\nwd.pdf')).toBe('passwd.pdf'));
it('defaults empty', () => expect(sanitizeFilename('  ')).toBe('attachment.pdf'));
it('encodes non-ascii', () => expect(contentDisposition('factuur €.pdf'))
  .toBe(`attachment; filename="factuur _.pdf"; filename*=UTF-8''factuur%20%E2%82%AC.pdf`));
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: pdf acceptance check and filename sanitising`.

---

### Task 4: Ingest (`email()` handler)

**Files:**
- Create: `src/ingest/ingest.ts`, `test/mail-builder.ts`
- Modify: `src/index.ts` (wire `email`)
- Test: `test/ingest.test.ts`

**Interfaces:**
- Consumes: `Config`, `insertMessage`, `bumpStat`, `isAcceptedPdf`, `AttachmentRow`, `MessageRow`.
- Produces:
  - `type IngestInput = { raw: ReadableStream | ArrayBuffer | string; rawSize: number; envelopeTo: string; envelopeFrom: string }`
  - `type IngestDeps = { db: D1Database; bucket: Pick<R2Bucket, 'put' | 'delete'> }`
  - `type IngestOutcome = { status: 'stored'; id: string; attachments: number; incomplete: boolean } | { status: 'rejected'; reason: 'too_large' | 'unknown_domain' }`
  - `ingestEmail(input: IngestInput, deps: IngestDeps, cfg: Config, now: number): Promise<IngestOutcome>`
  - `email(message, env, ctx)` in `index.ts`: builds input from `message.raw`, `message.rawSize`, `message.to`, `message.from`; on `too_large` calls `message.setReject('Message too large')`; on `unknown_domain` returns silently.
  - Test-only `buildMail(opts: { from?: string; fromName?: string; to: string; headerTo?: string; subject?: string; text?: string; html?: string; htmlQuotedPrintable?: boolean; attachments?: Array<{ filename?: string; contentType: string; bytes: Uint8Array }> }): string` and `makePdf(label: string): Promise<Uint8Array>` (pdf-lib, one page with `label`, so each PDF has distinct bytes).

Behaviour (spec §5, in this order): size check on `rawSize` → split `envelopeTo.toLowerCase()` at last `@` → domain allow-list → `PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })` (check the option name in the installed version; pick the raw-bytes mode) → bodies truncated to `maxBodyBytes` by UTF-8 byte length without splitting a character → headers JSON → filter attachments with `isAcceptedPdf`, skip `disposition === 'inline'` with a `contentId`, take first `maxAttachments` that are `<= maxAttachmentBytes`, count the rest in `skipped_attachments` → per kept PDF: UUID, `crypto.subtle.digest('SHA-256')` hex, `bucket.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { messageId } })` → if any put throws: delete keys already written, store message with zero attachment rows and `attachments_incomplete = 1` → `insertMessage` → if it throws: delete all written keys and rethrow → `bumpStat(incoming)`. Rejections bump `rejected` (domain = the allowed domain for `too_large` if known, else `_other`). `from_name` = parsed `from.name` or null; `from_addr` = parsed `from.address` falling back to `envelopeFrom`.

- [ ] **Step 1: Write `test/mail-builder.ts`** (multipart/mixed → multipart/alternative text+html, base64 attachments, optional quoted-printable HTML with `=\r\n` soft breaks every 76 chars and `=` encoded as `=3D`). It is test code; keep it small.
- [ ] **Step 2: Write failing tests** in `test/ingest.test.ts` (call `ingestEmail` directly with `env.DB`/`env.BUCKET`, fixed `now`):
  - `stores an Action-shaped invoice mail` — one ~60 KB PDF from `makePdf`; expect `stored`, one attachments row, R2 object bytes' SHA-256 equals SHA-256 of the input PDF, `expires_at - received_at === 72 * 3_600_000`.
  - `keeps two same-named PDFs distinct` — two `invoice.pdf` with different bytes → two rows, different ids, different sha256.
  - `ignores non-PDF attachments` — a PNG and a `.docx` → zero rows, `skipped_attachments` 0 (ignored, not skipped).
  - `skips PDFs over the count and size caps` — cfg with `maxAttachments: 2`, three PDFs → 2 rows, `skipped_attachments` 1; cfg with `maxAttachmentBytes: 1000` → 0 rows, skipped 1.
  - `rejects oversize without writing anything` — `rawSize: cfg.maxMessageBytes + 1` → `{ status: 'rejected', reason: 'too_large' }`, both tables empty, `BUCKET.list()` empty, `rejected` stat 1.
  - `drops unknown domain` — `to: 'x@other.example'` → `unknown_domain`, `rejected` under `_other`.
  - `R2 failure stores mail flagged incomplete` — bucket whose second `put` throws → `stored`, `incomplete: true`, zero attachment rows, `BUCKET.list()` empty.
  - `D1 failure rolls back R2 and throws` — db wrapper whose `batch` throws → promise rejects, `BUCKET.list()` empty.
  - **Review Focus 1:** `lowercases recipient, keeps plus` — envelope `AutoUser+1@STAGING.TEST.EXAMPLE` → row `inbox === 'autouser+1'`, `domain === 'staging.test.example'`.
  - **Review Focus 2:** `files by envelope recipient` — `headerTo: 'someone-else@staging.test.example'`, envelope `real@staging.test.example` → row inbox `real`.
  - `truncates bodies to maxBodyBytes on a character boundary` — html of 2 MB of `é` with cfg `maxBodyBytes: 1_048_576` → stored `html_body` UTF-8 length ≤ limit and decodes without U+FFFD.
- [ ] **Step 3: Run** `pnpm test test/ingest.test.ts` → FAIL.
- [ ] **Step 4: Implement** `ingestEmail` and wire `email()` in `index.ts`.
- [ ] **Step 5: Run** → PASS. Also run `pnpm test` (all) → PASS.
- [ ] **Step 6: Commit** `feat: inbound mail ingest with PDF storage and integrity rules`.

---

### Task 5: CPU measurement checkpoint (needs the user)

**Files:**
- Create: `scripts/cpu-sample.ts` (writes `cpu-sample-60k.eml`, `cpu-sample-1m.eml`, `cpu-sample-5m.eml` to a gitignored `tmp/` using `buildMail` + `makePdf` padded to size)
- Modify: `README.md` (add a "CPU measurements" section with results)

This is the spec's go/no-go for the free Workers plan. It requires the user's Cloudflare account, the domain and Email Routing for at least `ecom-staging` (spec §14 steps 1–4, minimal: D1, R2, `API_TOKENS`, deploy).

- [ ] **Step 1:** Generate the three sample mails.
- [ ] **Step 2: Stop and ask the user** to complete spec §14 steps 1–4 (or do them with the user at the keyboard), then send each sample from a normal mail client to `cpu-test@ecom-staging.flaky-tests.uk`.
- [ ] **Step 3:** Read CPU time per invocation from `wrangler tail --format json` (`cpuTime`/outcome fields) or the dashboard's Worker metrics. Record each size's CPU ms and outcome (`ok` vs `exceededCpu`).
- [ ] **Step 4:** Set `MAX_ATTACHMENT_BYTES` in `wrangler.toml` to the largest tested size that stays inside the free limit with headroom (and `MAX_MESSAGE_BYTES` to match). If even the 60 KB sample exceeds the limit, **stop and ask the user** about the 5 USD/month plan before continuing.
- [ ] **Step 5: Commit** `docs: record CPU measurements and set attachment cap`.

If the user isn't ready to deploy yet, skip to Task 6 and come back to this task before Task 14; nothing in Tasks 6–13 depends on its result except the cap value.

---

### Task 6: API — auth, inbox list, message detail, links

**Files:**
- Create: `src/api/auth.ts`, `src/api/app.ts`, `src/links.ts`, `src/shapes.ts`
- Modify: `src/config.ts` (use `parseApiTokens`), `src/index.ts` (mount API app)
- Test: `test/auth.test.ts`, `test/links.test.ts`, `test/api.test.ts`

**Interfaces:**
- Consumes: `getMessage`, `listMessages`, `listAttachments`, `bumpStat`, `Config`.
- Produces:
  - `parseApiTokens(raw: string | undefined): Record<string, string[]>` — invalid JSON or wrong shape → `{}` and `console.error` (fail closed); keys lowercased; arrays truncated to 2; empty strings dropped.
  - `isTokenValid(header: string | null, domain: string, tokens: Record<string, string[]>): Promise<boolean>` — SHA-256 both sides, `crypto.subtle.timingSafeEqual`; check all candidates without early exit.
  - `extractLinks(html: string | null, text: string | null): string[]`
  - `toInboxEntry(row: MessageSummary, now: number): { id; from; fromfull; subject; to; origTo; time; seconds_ago }` — `from = from_name ?? from_addr`, `subject = subject ?? ''`, `to = inbox`, `origTo = to_addr`, `time = received_at`, `seconds_ago = Math.floor((now - received_at) / 1000)`.
  - `toMessageDetail(row: MessageRow, atts: AttachmentRow[], now: number): MessageDetail` — the JSON the UI's JSON tab also shows.
  - `createApiApp(): Hono<{ Bindings: Env }>` mounted under `/api/v2`.

`extractLinks` algorithm (spec §6): scan `html` for `href` attributes with a regex accepting `"…"`, `'…'` or unquoted values; decode entities (`&amp; &lt; &gt; &quot; &#39; &apos;`, `&#NN;`, `&#xHH;`); trim; then scan `text` with `/https?:\/\/[^\s<>"')\]]+/g` and strip trailing `.,;:!?`; keep only values whose `new URL(v).protocol` is `http:` or `https:`; dedupe preserving first-seen order.

- [ ] **Step 1: Check Mailinator's v2 docs** (https://www.mailinator.com/docs/index.html — "Fetch Inbox", "Fetch Message", "Fetch Links", "Fetch Attachments"). Write the exact field names and types you find into a comment block at the top of `src/shapes.ts`, with the doc URL. Adjust `toInboxEntry`/`toMessageDetail`/links rules to match where they differ from the spec; the fields the helper reads (`id, subject, to, from, seconds_ago`, `msgs`, `links`) keep these names regardless.
- [ ] **Step 2: Write failing tests.**
  `test/links.test.ts`:
  - `decodes &amp; in href` — `<a href="https://x.test/v?a=1&amp;b=2">` → `['https://x.test/v?a=1&b=2']`.
  - `html first, then text, deduped` — html has U1, text has U2 and U1 → `[U1, U2]`.
  - `drops mailto, tel, relative and #` .
  - `strips trailing punctuation from text urls` — `"Go to https://x.test/a."` → `['https://x.test/a']`.
  - **Review Focus 3:** `handles null bodies` — `extractLinks(null, null)` → `[]`.
  `test/auth.test.ts`:
  - `accepts either of two tokens`, `rejects other domain's token`, `rejects Bearer prefix`, `rejects null`, `parseApiTokens fails closed on bad JSON`.
  `test/api.test.ts` (ingest fixtures with `ingestEmail`, then `SELF.fetch('http://127.0.0.1:8787/api/v2/...', { headers: { Authorization: 'stage-token-a' } })`):
  - `lists newest first with helper fields` — two mails → `msgs[0].id` is the newer, each has `id, subject, to, from, seconds_ago` with correct types.
  - `empty inbox is 200 with msgs []`.
  - `401 on missing, wrong, Bearer, and cross-domain token`, each body `{ error: ... }`, and an `api_error` stat bump.
  - `404 on domain not in ALLOWED_DOMAINS` (with any token).
  - **Review Focus 1:** `finds inbox case-insensitively` — `GET .../inboxes/AutoUser+1` returns the mail stored as `autouser+1` (URL-encode `+` as `%2B`; also assert a literal `+` in the path works).
  - `links come from the right message` — mails A and B in one inbox with different URLs → `/messages/A/links` contains only A's.
  - **Review Focus 4:** `quoted-printable verification link is byte-exact` — fixture with `htmlQuotedPrintable: true` and a 200-char `https://gigya.test/verify?token=…&amp;lang=nl` href → `/links` equals the decoded URL exactly.
  - `message under wrong inbox or domain is 404`.
  - `expired message is hidden` — ingest with `now - 73h` → list empty, detail 404, links 404.
  - **Review Focus 3:** `mail with no subject and no html lists and has detail` — `subject: ''` in list, detail 200.
  - `stats: list bumps api_inbox, links bumps api_message and accessed_api`.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.** Routes: `GET /domains/:domain/inboxes/:inbox`, `GET .../messages/:id`, `GET .../messages/:id/links`. Middleware order: lowercase params → domain allow-list (404) → `isTokenValid` (401) → handler. A stats middleware wraps everything and, after the response, bumps the endpoint-type metric, `api_error` when `status >= 400`, `accessed_api` for 2xx detail/links/attachment routes; domain = path domain if allowed else `_other`. Use `ctx.waitUntil` for stat writes.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat: Mailinator-compatible API with per-domain tokens and links`.

---

### Task 7: API — attachments

**Files:**
- Create: `src/attachments.ts`
- Modify: `src/api/app.ts`, `src/shapes.ts`
- Test: `test/attachments.test.ts`

**Interfaces:**
- Consumes: `getAttachmentForMessage`, `listAttachments`, `getMessage`, `contentDisposition`.
- Produces:
  - `serveAttachment(env: Pick<Env,'DB'|'BUCKET'>, p: { domain: string; inbox: string; messageId: string; attachmentId: string; now: number }): Promise<Response>` — 404 JSON when the JOIN returns null; 500 JSON + `console.error` when the R2 object is missing or `obj.size !== row.size`; else 200 streaming `obj.body` with `Content-Type` (stored), `Content-Length`, `Content-Disposition` (`contentDisposition(row.filename)`), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
  - `toAttachmentMeta(a: AttachmentRow): { id; filename; contentType; size; sha256 }`
  - Routes `GET .../messages/:id/attachments` → `{ attachments: AttachmentMeta[], attachmentsIncomplete: boolean }` (404 if the message isn't found under that domain/inbox) and `GET .../messages/:id/attachments/:attachmentId` → `serveAttachment`.

- [ ] **Step 1: Write failing tests** (all through `SELF.fetch` on the API host):
  - `download is byte-identical` — SHA-256 of the response body equals SHA-256 of the PDF given to `buildMail`; headers include `nosniff`, `Content-Length`, and `attachment;`.
  - `two mails, each URL returns only its own file` — compare hashes.
  - `A's attachment id under B's message URL is 404`.
  - `right ids under wrong inbox or wrong domain are 404` (wrong domain uses the prod token so the 404 comes from the lookup, not auth).
  - `two invoice.pdf in one mail are both downloadable and differ`.
  - `listing shows attachmentsIncomplete for a flagged message`.
  - `size mismatch returns 500` — overwrite the R2 object with different-length bytes, expect 500, body not PDF.
  - `expired message's attachment is 404`.
  - **Review Focus 5:** `awkward filename gives safe header` — attachment named `../x"\r\n€.pdf` → `Content-Disposition` contains no CR/LF, no `/`, and a `filename*=UTF-8''` part; and an attachment with no filename downloads as `attachment.pdf`.
  - `accessed_api and api_attachment stats bump on download`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: attachment list and verified download endpoints`.

---

### Task 8: Cleanup (`scheduled()` handler)

**Files:**
- Create: `src/cleanup.ts`
- Modify: `src/index.ts` (wire `scheduled` → `ctx.waitUntil(runCleanup(env, cfg, Date.now()))`)
- Test: `test/cleanup.test.ts`

**Interfaces:**
- Consumes: `listExpiredIds`, `deleteMessages`, `purgeOldStats`.
- Produces: `runCleanup(env: Pick<Env,'DB'|'BUCKET'>, cfg: Config, now: number): Promise<{ deleted: number; orphans: number }>` — loop `listExpiredIds(db, now, 100)` → `deleteMessages` until empty; orphan sweep pages `BUCKET.list({ cursor })`, takes the message id from the key prefix, and deletes objects with `uploaded < now - 3_600_000` whose message id has no row (check ids per page with one `IN (...)` query); then `purgeOldStats(db, now, cfg.statsRetentionDays)`.

- [ ] **Step 1: Write failing tests:**
  - `deletes expired mail with its R2 objects, keeps fresh mail` — ingest one mail at `now - 73h` with a PDF and one at `now`; run; expired: no rows, R2 key gone; fresh: intact.
  - `removes orphan R2 objects older than an hour, keeps recent ones` — put `orphan-id/x` (no row); since R2 `uploaded` is real time, pass `now = Date.now() + 2 * 3_600_000` for the "old" case and `Date.now()` for the "recent" case.
  - `purges stats older than 90 days`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: hourly cleanup of expired mail, orphans and old stats`.

---

### Task 9: Playwright API end-to-end and helper compatibility

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/deliver.ts`, `e2e/mailinator-client.ts`, `e2e/api.spec.ts`, `e2e/helper-compat.spec.ts`
- Test: those specs

**Interfaces:**
- Consumes: `buildMail`, `makePdf` (import from `test/mail-builder.ts`); the running dev server.
- Produces: `deliverMail(request: APIRequestContext, raw: string, from: string, to: string): Promise<void>` — `POST http://localhost:8787/cdn-cgi/handler/email?from=…&to=…` with the raw MIME body (check the current Wrangler docs for the exact local email-handler path and parameters; update this function only).

Config: `webServer: { command: 'pnpm wrangler dev --port 8787 --persist-to .wrangler/e2e', url: 'http://localhost:8787', reuseExistingServer: !process.env.CI }`; `globalSetup` runs `wrangler d1 migrations apply flaky-inbox --local --persist-to .wrangler/e2e` after deleting `.wrangler/e2e`. API base `http://127.0.0.1:8787/api/v2`. Each test uses a unique inbox (`crypto.randomUUID()`), so tests can run in parallel.

`e2e/mailinator-client.ts`: copy `MailinatorClient` from `action/web/tests/core/helpers/` verbatim; change only the imports — replace `testConfig` with a local object `{ mailinator: { apiBaseUrl, domain } }` read from env, and replace `@step` with a no-op decorator. Do not change any method body.

- [ ] **Step 1: Write `e2e/api.spec.ts`** covering, over real HTTP, the spec §12 list that isn't time-based: PDF round-trip by SHA-256; two mails isolated; cross-message 404; wrong domain/inbox 404; duplicate filenames; 401 cases including cross-domain and `Bearer`; both staging tokens work; links from HTML and text with `&amp;` decoded; empty inbox `msgs: []`; non-PDF ignored; oversize mail leaves nothing (deliver a mail with `rawSize` above the local `MAX_MESSAGE_BYTES` — set the local cap low, e.g. 200 KB, in `.dev.vars.example` comment for e2e via `wrangler dev --var MAX_MESSAGE_BYTES:200000`). Retention is covered by Vitest (Task 8), not here.
- [ ] **Step 2: Write `e2e/helper-compat.spec.ts`:** deliver a mail whose HTML has `<a href="https://gigya.test/verify?x=1&amp;y=2">`, then `new MailinatorClient(request, 'staging.test.example').waitForLinkStartingWith(inbox, 'https://gigya.test/verify', { timeout: 15_000 })` resolves to `https://gigya.test/verify?x=1&y=2`; and `getMessages` returns the newest first. Set `MAILINATOR_API_KEY=stage-token-a` for the spec.
- [ ] **Step 3: Run** `pnpm e2e` → PASS (all previous tasks already implement the behaviour; a failure here is a real bug — fix the code, not the test).
- [ ] **Step 4: Commit** `test: Playwright API suite and Mailinator helper compatibility`.

---

### Task 10: UI auth and shell

**Files:**
- Create: `src/ui/access.ts`, `src/ui/app.tsx`, `src/ui/layout.tsx`, `src/ui/client.ts`
- Modify: `src/index.ts` (mount UI app), `tsconfig.json` (`"jsx": "react-jsx", "jsxImportSource": "hono/jsx"`)
- Test: `test/access.test.ts`, `test/ui-auth.test.ts`

**Interfaces:**
- Produces:
  - `verifyAccessJwt(token: string | null, opts: { aud: string; issuer: string; jwks: JWTVerifyGetKey }): Promise<{ email: string } | null>` — `jose.jwtVerify` with `audience`, `issuer`, algorithms `['RS256']`; any error → `null`.
  - `accessJwks(teamDomain: string): JWTVerifyGetKey` — module-level cached `createRemoteJWKSet(new URL('https://' + teamDomain + '/cdn-cgi/access/certs'))`.
  - `createUiApp(): Hono<{ Bindings: Env; Variables: { user: string } }>` — first middleware: if `cfg.uiAuthMode === 'dev'` set `user = 'dev@local'`; else if `accessTeamDomain` or `accessAud` missing → 403 page; else verify `Cf-Access-Jwt-Assertion` (issuer `https://<teamDomain>`) → 403 on null. Second middleware for non-GET: `Origin` must equal `cfg.uiOrigin` else 403. Every UI response gets `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; img-src * data:; style-src 'self' 'unsafe-inline'; frame-src 'self' about:; frame-ancestors 'none'` (adjust only if the iframe `srcdoc` needs it), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`.
  - `Layout({ title, user, active, children })` — nav: brand "flaky inbox", links Inbox (`/`) and Statistics (`/stats`), user email on the right.
  - `clientScript: string` — exported inline JS, filled in Tasks 11–12.

- [ ] **Step 1: Write failing tests.**
  `test/access.test.ts` (generate an RS256 key pair with `jose.generateKeyPair`, sign tokens, pass `createLocalJWKSet`):
  - `accepts valid token and returns email`, `rejects wrong aud`, `rejects wrong issuer`, `rejects expired`, `rejects null`.
  `test/ui-auth.test.ts` (miniflare binding override `UI_AUTH_MODE: 'access'`, `ACCESS_TEAM_DOMAIN: 'team.test'`, `ACCESS_AUD: 'aud'`, fetch on `http://localhost:8787/`):
  - `refuses UI without assertion` → 403.
  - `refuses UI when access config missing` (unset team domain) → 403.
  - `dev mode serves the shell` (default test bindings) → 200, body contains `flaky inbox`.
  - `POST with foreign Origin is 403` (dev mode).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: UI shell behind Cloudflare Access verification`.

---

### Task 11: UI inbox view and delete

**Files:**
- Create: `src/ui/inbox.tsx`
- Modify: `src/ui/app.tsx`, `src/ui/client.ts`
- Test: `test/ui-inbox.test.ts`, `e2e/ui.spec.ts` (inbox part)

**Interfaces:**
- Consumes: `listMessages`, `deleteMessages`, `relativeAge`, `Layout`.
- Produces routes:
  - `GET /?domain=<d>&inbox=<prefix>&page=<n>` — full page. `domain` defaults to `cfg.allowedDomains[0]`; unknown domain → first allowed. 50 per page.
  - `GET /rows?domain&inbox&page` — returns only the `<tbody>` HTML (for auto-refresh).
  - `POST /delete` — form fields `ids` (repeated) and `back` (a relative URL starting with `/`; anything else → `/`). Calls `deleteMessages`, redirects 303 to `back`.
  - Row markup: `<tr data-id="<id>">` with checkbox `name="ids" value="<id>"`, To (inbox), From (`from_name ?? from_addr`), Subject (`(no subject)` when empty), PDF count, Received (`relativeAge(now - received_at)` with `title` = ISO time); whole row links to `/m/<domain>/<inbox>/<id>`.
  - `clientScript` additions: every 10 s while `document.visibilityState === 'visible'`, fetch `/rows` with the current query, remember checked ids, swap `<tbody>`, re-check remembered ids; "select all" toggles boxes on the page; Delete button `confirm(\`Delete ${n} mails and their attachments?\`)` (singular "mail" when n = 1), disabled when none checked.

- [ ] **Step 1: Write failing tests.**
  `test/ui-inbox.test.ts` (dev mode, `SELF.fetch` on `http://localhost:8787`):
  - `shows only the selected domain's mail, newest first`.
  - `prefix filter matches inbox start`.
  - `paginates at 50` — 51 mails → page 1 has 50 rows and a next link; page 2 has 1.
  - `hides expired mail`.
  - `POST /delete removes mail and R2 objects` — with `Origin: http://localhost:8787`; then `/rows` no longer has the id; R2 key gone.
  - `POST /delete ignores off-site back` — `back=https://evil.example` → `Location: /`.
  - **Review Focus 3:** `mail with no subject shows (no subject)`.
  `e2e/ui.spec.ts`: `auto-refresh keeps ticked boxes` — open inbox, tick a row, deliver a new mail, wait for the new row to appear (≤ 15 s), assert the earlier box is still checked; `delete selected asks and removes` — accept the dialog, rows gone.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test` and `pnpm e2e -g inbox` → PASS.
- [ ] **Step 5: Commit** `feat: UI inbox view with filter, paging, refresh and delete`.

---

### Task 12: UI message page and download

**Files:**
- Create: `src/ui/message.tsx`
- Modify: `src/ui/app.tsx`, `src/ui/client.ts`
- Test: `test/ui-message.test.ts`, `e2e/ui.spec.ts` (message part)

**Interfaces:**
- Consumes: `getMessage`, `listAttachments`, `toMessageDetail`, `extractLinks`, `serveAttachment`, `bumpStat`.
- Produces routes:
  - `GET /m/:domain/:inbox/:id` — 404 page if `getMessage` is null. Header: To (`to_addr`), From (`from_addr`), Received, Expires (ISO-like `YYYY-MM-DD HH:mm:ss` UTC, labelled UTC). Attachments box: rows of filename, human size, first 8 hex of sha256 with full value in `title`, Download link to `/m/:domain/:inbox/:id/a/:attachmentId`; when `attachments_incomplete`, a visible warning "Some attachments could not be stored"; when `skipped_attachments > 0`, "N PDF(s) were over the limit and not stored". Tabs (plain JS show/hide, HTML active by default): HTML → `<iframe sandbox="" srcdoc="…">` (attribute-escaped `html_body`; omit the tab when null), TEXT → `<pre>` escaped, JSON → `<pre>` of `JSON.stringify(toMessageDetail(...), null, 2)`, LINKS → `<ul>` of `<a href rel="noreferrer noopener" target="_blank">`. Delete button posts to `/delete` with `back=/?domain=<domain>`. Bumps `accessed_ui`.
  - `GET /m/:domain/:inbox/:id/a/:attachmentId` → `serveAttachment(...)`, bumps `accessed_ui` on 200.

- [ ] **Step 1: Write failing tests** (`test/ui-message.test.ts`, dev mode):
  - `renders header, attachments and four tabs`.
  - `iframe is sandboxed without allow-scripts` — HTML body `<script>alert(1)</script><p>hi</p>` → response contains `sandbox=""` and does not contain an unescaped `<script>alert(1)` outside the `srcdoc` attribute (assert `srcdoc` contains `&lt;script&gt;`).
  - `JSON tab equals API detail` — parse the `<pre>` JSON and deep-equal the API's detail response for the same message.
  - `UI download is byte-identical and binding-checked` — correct path 200 with matching SHA-256; A's attachment under B's path 404.
  - `shows incomplete warning`.
  - `wrong domain or inbox is 404`.
  - `accessed_ui bumps on view and download`.
  `e2e/ui.spec.ts`: `tabs switch and LINKS lists the decoded link`; `download button saves a file with the right hash` (Playwright `page.waitForEvent('download')`, hash the saved file).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: UI message page with tabs and verified downloads`.

---

### Task 13: UI statistics page

**Files:**
- Create: `src/ui/stats.tsx`
- Modify: `src/ui/app.tsx`
- Test: `test/ui-stats.test.ts`

**Interfaces:**
- Consumes: `readStats`.
- Produces: `GET /stats?domain=<d|all>` — default `all`; table with grouped headers: Date | Emails incoming (Stored, Rejected) | Emails accessed (API, UI) | API calls (Inbox, Message, Attachment, Errors); one row per day, newest first, last `cfg.statsRetentionDays` days; dropdown of allowed domains plus "All". `_other` counts only appear under "All".

- [ ] **Step 1: Write failing tests:** seed `daily_stats` rows directly for two days and two domains; `domain=all sums both`; `domain filter shows one`; `rows newest first`; `columns in the order above` (check header text sequence).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; add one `e2e/ui.spec.ts` check that `/stats` shows `Stored` ≥ 1 after delivering a mail.
- [ ] **Step 5: Commit** `feat: UI statistics page`.

---

### Task 14: README, CI and first deploy

**Files:**
- Create: `README.md` (or extend from Task 5), `.github/workflows/ci.yml`
- Modify: `wrangler.toml` (real `database_id` from the user), `.dev.vars.example`

- [ ] **Step 1: Write `README.md`** with: what it is; local dev (`cp .dev.vars.example .dev.vars`, `pnpm wrangler d1 migrations apply flaky-inbox --local`, `pnpm dev`, how to send a test mail to the local handler); tests (`pnpm test`, `pnpm e2e`); Cloudflare setup following spec §14 in order, including Email Routing per subdomain (record whether one catch-all covered both subdomains or each needed a rule), `workers_dev` check, custom domains, Access application + policy (say "add your allowed addresses in the dashboard"; no addresses in the README), generating tokens (`openssl rand -hex 32`) and `wrangler secret put API_TOKENS` JSON format, token rotation steps; how Email Routing treats a thrown `email()` error (find out from Cloudflare docs and write it down); CPU measurements (Task 5); pointing `action/web` at the service (spec §15).
- [ ] **Step 2: Write `.github/workflows/ci.yml`:** on push and PR — `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm exec playwright install --with-deps chromium`, `pnpm e2e`. A `deploy` job on push to `main` only, after tests: `wrangler d1 migrations apply flaky-inbox --remote` then `wrangler deploy`, using secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The deploy job must not print secrets.
- [ ] **Step 3: Run** `pnpm typecheck && pnpm test && pnpm e2e` locally → PASS. Run `git grep -nE '@gmail|@action\.nl|[0-9a-f]{32}'` → only expected hits (`action.nl` in prose is fine; no personal addresses, no tokens, no ids).
- [ ] **Step 4: Stop and ask the user** to do spec §14 steps 1–6 (or the parts not done in Task 5), add the GitHub secrets, and confirm the real-mail checksum test (§14.6) passes. Record the outcome in the README.
- [ ] **Step 5: Commit** `docs: README, CI workflow and deploy notes`.

---

### Task 15: Live acceptance gate (needs the user) — before any `action/web` change

Nothing in `action/web` changes until every box below is ticked on the deployed service. This plan never edits `action/web`; spec §15 is a separate, later piece of work that starts only after this gate.

**Files:**
- Create: `e2e/live.spec.ts` (skipped unless `LIVE_API_BASE`, `LIVE_DOMAIN` and `MAILINATOR_API_KEY` are set), `docs/acceptance.md` (results log)

- [ ] **Step 1: Write `e2e/live.spec.ts`**, reusing the copied `MailinatorClient` unchanged, pointed at `LIVE_API_BASE` (`https://mail-api.flaky-tests.uk/api/v2`) and `LIVE_DOMAIN`. It reads an inbox given in `LIVE_INBOX` and asserts: `getMessages` returns ≥ 1 mail with the helper's fields; `waitForLinkStartingWith(LIVE_INBOX, LIVE_LINK_PREFIX)` resolves; if `LIVE_EXPECT_PDF=1`, the attachment list has ≥ 1 PDF and its download's SHA-256 equals the listed `sha256`.
- [ ] **Step 2: Real sign-up mail.** The user registers a new account on Action staging by hand with `accept-<date>@ecom-staging.flaky-tests.uk`. Run `live.spec.ts` with that inbox and the Gigya verification prefix → PASS. Open the verification link from the UI's LINKS tab in a browser and confirm the account gets verified (proves the link is byte-exact).
- [ ] **Step 3: Real order with invoice.** The user places a staging order to an `ecom-staging` address. Run `live.spec.ts` with `LIVE_EXPECT_PDF=1` → PASS. Open the PDF from the UI and check that it opens.
- [ ] **Step 4: Production domain.** Send one mail to an `ecom-production` address. Confirm it's readable with the production token, that the staging token gets 401 on it, and that it never shows under the staging domain in the API or the UI.
- [ ] **Step 5: Security checks against the live service:**
  - `curl https://mail-api.flaky-tests.uk/api/v2/domains/ecom-staging.flaky-tests.uk/inboxes/x` without a token → 401.
  - `https://mailinat.flaky-tests.uk` in a private window → Access login page.
  - An address outside the allow policy can't log in.
  - The `*.workers.dev` URL doesn't respond.
  - The R2 bucket has public access off.
- [ ] **Step 6: Cleanup works live.** Set `RETENTION_HOURS=1` temporarily, deliver a mail with a PDF, wait for two cron runs, and confirm the mail and its R2 object are gone. Then set it back to 72 and redeploy.
- [ ] **Step 7: Stats.** The UI stats page shows the incoming, accessed and API-call counts from the steps above, under the right domain.
- [ ] **Step 8: Record and commit.** Write each step's date and result in `docs/acceptance.md` and commit `docs: live acceptance results`. Report to the user that the service is proven and that the `action/web` switch-over (spec §15) can start as its own piece of work.

---

## Self-review notes

- Spec coverage: §3 hosts → T1; §5 → T4; CPU spike §13.2 → T5; §6 → T6, T7; §7 → T10–T12; §8 → T8; §9 → T2 (counters), T6/T7/T12 (bumps), T13 (page); §10 → T1; §11 → T1, T14; §12 → T2–T13 (Vitest), T9, T11–T13 (Playwright); §14 → T5, T14; §15 is out of scope (README only).
- Build order differs from spec §13 in one place: the CPU spike (T5) comes after ingest (T4), because it needs the ingest code to measure. It still comes before the API and UI are built.
