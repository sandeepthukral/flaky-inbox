# Live acceptance checklist

**No change is made in `action/web` until every item below is ticked on the deployed service.**

Use made-up inbox names only. Do not paste tokens, real addresses or real mail content here.

## Running the live spec

`e2e/live.spec.ts` must run **alone**. The Mailinator helper reads `MAILINATOR_API_BASE_URL` once, when
it is first imported. If another spec in the same Playwright worker imported it first, the live spec
silently talks to `127.0.0.1` instead of the live service. So always name the file:

```sh
LIVE_API_BASE=https://mail-api.flaky-tests.uk/api/v2 \
LIVE_DOMAIN=ecom-staging.flaky-tests.uk \
MAILINATOR_API_KEY=<staging token> \
LIVE_INBOX=<inbox name> \
LIVE_LINK_PREFIX=<verification URL prefix> \
LIVE_EXPECT_PDF=1 \
pnpm e2e live.spec.ts
```

Leave out `LIVE_EXPECT_PDF` (or `LIVE_LINK_PREFIX` where there is no link) for steps that do not need it.
Without `LIVE_API_BASE`, `LIVE_DOMAIN` and `MAILINATOR_API_KEY` the spec is skipped.

## Step 2: Real sign-up mail

- [ ] Registered a new account on Action staging with `accept-<date>@ecom-staging.flaky-tests.uk`
- [ ] `live.spec.ts` passes for that inbox with the Gigya verification prefix
- [ ] Opened the verification link from the UI's LINKS tab in a browser; the account is verified (link is byte-exact)

Date: ____
Result: ____
Notes: ____

## Step 3: Real order with invoice

- [ ] Placed a staging order to an `ecom-staging` address
- [ ] `live.spec.ts` passes with `LIVE_EXPECT_PDF=1`
- [ ] Opened the PDF from the UI and it opens

Date: ____
Result: ____
Notes: ____

## Step 4: Production domain isolation

- [ ] Sent one mail to an `ecom-production` address
- [ ] It is readable with the production token
- [ ] The staging token gets 401 on it
- [ ] It never shows under the staging domain, in the API or in the UI

Date: ____
Result: ____
Notes: ____

## Step 5: Security checks against the live service

- [ ] `curl https://mail-api.flaky-tests.uk/api/v2/domains/ecom-staging.flaky-tests.uk/inboxes/x` without a token returns 401
- [ ] `https://mailinat.flaky-tests.uk` in a private window shows the Access login page
- [ ] An address outside the allow policy cannot log in
- [ ] The `*.workers.dev` URL does not respond
- [ ] The R2 bucket has public access off

Date: ____
Result: ____
Notes: ____

## Step 6: Cleanup works live

- [ ] Set `RETENTION_HOURS="1"` temporarily by editing `[vars]` in `wrangler.toml` (not the dashboard: deploys overwrite it), ran `pnpm run deploy`, and delivered a mail with a PDF
- [ ] After two cron runs, the mail and its R2 object are gone
- [ ] Reverted `RETENTION_HOURS` to `"72"` in `wrangler.toml` and redeployed (`pnpm run deploy`)

Date: ____
Result: ____
Notes: ____

## Step 7: Stats

- [ ] The UI stats page shows the incoming, accessed and API-call counts from the steps above, under the right domain

Date: ____
Result: ____
Notes: ____

## Sign-off

- [ ] Every item above is ticked. The `action/web` switch-over (README, "Pointing `action/web` at the service") may start as its own piece of work.

Date: ____
