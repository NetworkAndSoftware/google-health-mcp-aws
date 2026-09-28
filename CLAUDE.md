# Google Health MCP Server

## Project Overview

An MCP server that exposes sleep and recovery data from the Google Health API (Fitbit / Pixel Watch) as tools, for a Claude training coach tracking recovery: HRV, sleeping and resting heart rate, SpO2, breathing rate, skin temperature and sleep. It's hosted on AWS Lambda as an OAuth-protected claude.ai custom connector (web, mobile, Desktop), shared by several people who each sign in with their own Google account.

It's a sibling of `../intervals-icu-mcp` (same stack and Lambda setup) and `../wahoo-systm-mcp-aws`. The same coach uses all three.

## Tech Stack

- **Runtime:** Node.js (TypeScript), ESM
- **MCP SDK:** `@modelcontextprotocol/sdk` (`McpServer.registerTool`, zod input schemas)
- **Transport:** stateless Streamable HTTP (Express + `serverless-http`) on Lambda; the same Express app locally (`npm start`)
- **Build:** `npx tsc` → `dist/` (local run); `npm run build:lambda` (esbuild) → single-file bundle in `dist-lambda/`
- **Hosting:** AWS Lambda + Function URL via SAM (`template.yaml`), settings in SSM Parameter Store
- No stdio mode, no cache, no test framework, no linter

## Project Structure

```
src/
├── index.ts          # Local entry point: the Lambda app on localhost:3000, settings from .env
├── lambda.ts         # Lambda entry point: settings from SSM, wraps the app with serverless-http
├── http.ts           # Express app: OAuth routes, /oauth/callback, stateless /mcp
├── oauth.ts          # OAuth server for Claude that delegates sign-in to Google (stateless, sealed tokens)
├── google-oauth.ts   # Google's OAuth endpoints: consent URL, code exchange, refresh, revoke
├── seal.ts           # AES-256-GCM sealing of token claims
├── api.ts            # Google Health API v4 client and data point types
├── health.ts         # Shapes data for tools: sleep summaries, daily metric rows, dates, JSON output
├── server.ts         # createMcpServer(client): registers tools, server instructions
└── tools/
    ├── params.ts     # Shared date-range parameters and validation (max 92 days)
    ├── recovery.ts   # get_recovery_status, get_recovery_metrics
    └── sleep.ts      # get_sleep, get_night_detail
scripts/
├── build-lambda.mjs  # esbuild bundle → dist-lambda/index.mjs
└── admin.mjs         # npm run admin: Google client, allowlist, signing secret in SSM; recycles the Lambda
```

## Google Health API

- Reference: https://developers.google.com/health/reference/rest. The authoritative schema is the discovery document at `https://health.googleapis.com/$discovery/rest?version=v4`. Check it before trusting doc pages or summaries of them: some doc pages disagree with it on field names.
- Base: `https://health.googleapis.com/v4/users/me/dataTypes/{data-type}/dataPoints`, with `:reconcile` (GET), `:rollUp` and `:dailyRollUp` (POST), and plain `list` (GET).
- **Naming:** data type IDs in paths are kebab-case (`daily-resting-heart-rate`). The same names in filters are snake_case (`daily_resting_heart_rate.date`); camelCase in a filter returns `400 INVALID_DATA_POINT_FILTER`. Response fields are camelCase (`dailyRestingHeartRate`). int64 values arrive as strings.
- **Filters** (AIP-160, `>=` / `<`, `AND`):
  - Daily types: `{type}.date`.
  - Samples: `{type}.sample_time.physical_time` (RFC 3339) or `.civil_time`.
  - Sleep: `sleep.interval.civil_end_time` or `.end_time`. Sleep can't be filtered on start time.
  - Results come newest first.
- **Page size:** at most 25 for `sleep` and `exercise`, 10,000 for everything else.
- **reconcile vs list:** `list` returns every source's copy, so a night can appear once from Fitbit and again from Health Connect. `reconcile` merges them into one stream. Its `dataSourceFamily` defaults to all sources. The tools always use `reconcile`.
- **Rollups:** `rollUp` (physical time windows) supports `heart-rate`. For heart-rate, the range is at most 14 days, and so is `windowSize × pageSize`; otherwise Google answers `400 INVALID_ROLLUP_QUERY_DURATION`. The discovery document doesn't mention the second limit. Google's default page size (1,440) already breaks it for windows of 15 minutes or more, so `heartRateRollUp` sizes the page to the number of windows the range needs.
- **Personal ranges aren't available:** the discovery document says `dailyRollUp` on `daily-resting-heart-rate` / `daily-heart-rate-variability` returns Fitbit's personal range. The real API answers `400 DailyRollup is not supported for data type daily-heart-rate-variability, but the following actions are supported: list, reconcile` (2026-09-28).
- **Errors:** failed requests are logged to CloudWatch with the path, query or body, and Google's full error (including `details`). Error messages name the failing path, because Google's own message can be as vague as "Invalid argument in request". `get_night_detail` reports a failing stream under `unavailable` and still returns the rest.
- **Data types used:**
  - Sleep: `sleep`.
  - Daily: `daily-heart-rate-variability` (average RMSSD, deep-sleep RMSSD, non-REM heart rate), `daily-resting-heart-rate`, `daily-oxygen-saturation`, `daily-respiratory-rate`, `daily-sleep-temperature-derivations` (nightly and baseline skin temperature).
  - Samples: `heart-rate-variability`, `oxygen-saturation`, `respiratory-rate-sleep-summary` (per-stage breathing rate).
  - Rollup: `heart-rate`.
- **Scopes:** `googlehealth.sleep.readonly` and `googlehealth.health_metrics_and_measurements.readonly`, plus `openid email` for the allowlist. Every `googlehealth.*` scope is restricted. Adding a data type from another scope group (e.g. `activity_and_fitness` for VO2 max or exercise) means adding its scope in `google-oauth.ts` and in the Google Cloud consent screen, and everyone reconnecting.
- **Checked against real data (2026-09-28):** all four tools work on a real Fitbit account. What the real data showed:
  - Sleep `summary.minutesToFallAsleep` and `minutesAfterWakeUp` are always 0 for sleep the watch detected. The tools omit them when they're 0.
  - `respiratory-rate-sleep-summary` reports `breathsPerMinute: 0` for a stage it couldn't compute (seen for deep sleep despite 45 minutes of it), so 0 is treated as missing.
  - Google can flag a second long session with stages as a nap (`metadata.nap`), e.g. going back to sleep for almost 3 hours after waking at 03:11.
  - The daily HRV (`daily-heart-rate-variability`) differs from the average of the night's `heart-rate-variability` samples (15.8 vs 21.4 ms on one night). Fitbit computes it differently.
  - Not yet compared with the Fitbit app: the sleep summary minutes.

## Remote Hosting (AWS Lambda)

Setup and day-to-day commands are in README.md. Design notes and gotchas:

- **Why chained OAuth:** claude.ai connectors support only OAuth or no auth. `oauth.ts` is an authorization server on the SDK's `mcpAuthRouter` with DCR and PKCE:
  - `authorize()` redirects to Google's consent screen (`access_type=offline`, `prompt=consent` so a refresh token always comes back). Claude's authorization request travels, sealed, as Google's `state`.
  - Google returns to `/oauth/callback`, which exchanges the code. It reads the email from the ID token (trusted without signature checks, since it comes straight from Google's token endpoint over TLS) and checks it against `ALLOWED_EMAILS` and the granted scopes. Only then does it redirect to Claude with a code.
  - Disallowed accounts get their grant revoked at Google.
- **Stateless tokens:** client IDs, codes and tokens are sealed claims (AES-256-GCM, key derived from `MCP_SIGNING_SECRET`, with the token kind as associated data).
  - The access token carries the Google access token (`gat`) and expires a minute before it. The refresh token carries the Google refresh token (`grt`, 180 days, renewed on use).
  - `exchangeRefreshToken` refreshes at Google. Google's `invalid_grant` / `unauthorized_client` become `InvalidGrantError`, so Claude asks the person to reconnect. Other failures become `ServerError`, so the refresh can be retried.
  - Tool calls never touch Google's token endpoint.
  - There's no revocation endpoint: revoking at Google ends the grant for all of that person's connections.
- **Sign-out:** tokens carry the email, which is checked against the allowlist on every use, so `admin deny` signs someone out. `sign-out-all` rotates the signing secret. `admin google-client` with a different client ID also rotates it, because existing grants belong to the old client.
- **Origin:** OAuth metadata needs absolute URLs, but a Lambda can't know its Function URL at deploy time.
  - `http.ts` takes the origin from the `Host` header, only when it matches `*.lambda-url.*.on.aws`; `PUBLIC_URL` overrides this. Routes are built lazily, which is why the rate limiters have `creationStack` validation off.
  - The Google callback URL is `{origin}/oauth/callback`. It must be registered on the Google OAuth client; the stack output `GoogleRedirectUri` shows it.
- **serverless-http + MCP SDK:** the SDK's transport reads `req.rawHeaders`, which serverless-http leaves empty. `lambda.ts` rebuilds them, and without that every MCP call fails with "Not Acceptable".
- **Stateless MCP:** a new `McpServer` and transport per request (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). GET and DELETE on `/mcp` return 405.
- **Settings:** four SecureStrings under `/google-health-mcp/`: `MCP_SIGNING_SECRET`, `ALLOWED_EMAILS` (a JSON array), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. They're read once per cold start; a missing one fails the cold start. `scripts/admin.mjs` recycles the function after each change.
- **Google app status:** while the Google Auth Platform app is in Testing, Google refresh tokens die after 7 days. Published but unverified, the limit is 100 users behind an "unverified app" warning.
- **Deploy:** `sam deploy` zips `dist-lambda/` as-is. Don't run `sam build`. `@aws-sdk/*` is external in the bundle because the Node.js runtime provides it.

## Testing

No test framework in the repo. What worked while building it (scripts kept outside the repo):

- Patch `globalThis.fetch` with a fake Google: the OAuth token and revoke endpoints, plus Health API `reconcile` / `rollUp` / `dailyRollUp` with data shaped per the discovery document. The fake should enforce snake_case filters and the 25-per-page sleep limit.
- Import `dist/http.js`, start the app on localhost, and drive the whole flow with fetch: register, authorize, callback, token (PKCE), MCP `initialize`, `tools/list`, `tools/call`, refresh.
- For the Lambda bundle, run `dist-lambda/index.mjs` with `node --import` and a `module.register` hook that swaps `@aws-sdk/client-ssm` for a stub. Then feed the handler Function URL (payload v2) events with a `*.lambda-url.*.on.aws` Host header.
- `sam validate --lint` checks the template.

## Development Notes

- Keep the repo out of cloud-synced folders.
- Tool output is JSON with one array element per line (`toJson` in `health.ts`), to keep long timelines cheap in tokens.
- Dates default to UTC today plus a day, since the server runs in UTC and a day too many only means no data. Claude normally passes explicit dates.
