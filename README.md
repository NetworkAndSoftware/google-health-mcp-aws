# google-health-mcp-aws

An MCP (Model Context Protocol) server that gives Claude access to sleep and recovery data from a Fitbit or Pixel Watch, through the [Google Health API](https://developers.google.com/health) (the successor of the Fitbit Web API). It runs on AWS Lambda as a claude.ai custom connector, so it works in claude.ai on the web, on mobile and in Claude Desktop. Several people can share one deployment, and each signs in with their own Google account.

It's meant for a training coach in Claude: HRV, resting and sleeping heart rate, SpO2, breathing rate, skin temperature and sleep, compared with your own baseline.

- "How recovered am I this morning?"
- "How has my HRV trended over the last month?"
- "Show me last night's sleep in detail. When was my heart rate lowest?"
- "Did my sleep get worse during the training block that started on the 1st?"

## Tools

| Tool | Description |
|------|-------------|
| `get_recovery_status` | One morning's metrics against your baseline over the preceding days: mean, standard deviation, z-score and 7-day average for each metric. Includes flags for notable deviations, and last night's sleep. |
| `get_recovery_metrics` | One row per day: HRV (average and deep-sleep RMSSD), sleeping heart rate (non-REM), resting heart rate, SpO2 (average and range), breathing rate, skin temperature and its deviation from baseline, and minutes asleep. |
| `get_sleep` | Sleep sessions: bedtime, wake time, time asleep and awake, efficiency, time to fall asleep, awakenings, and minutes and percentages of deep, light and REM sleep. Naps are flagged, and a stage-by-stage timeline is optional. |
| `get_night_detail` | One night in 5-minute buckets (adjustable): sleep stage, heart rate, HRV and SpO2. Includes the night's average and lowest heart rate, SpO2 minimum, and breathing rate per sleep stage. |

All tools are read-only. Nightly metrics belong to the date you woke up, as in the Fitbit app.

## Setup

You need an AWS account, a Google account, and a Fitbit or Pixel Watch whose data is in that Google account. A Fitbit account has to be moved to a Google account for the Google Health API to see it.

Install Node.js 20+, the AWS CLI and the SAM CLI, then sign in to AWS with a default region:

```bash
winget install OpenJS.NodeJS.LTS
winget install Amazon.AWSCLI
winget install Amazon.SAM-CLI
aws configure        # or: aws login
npm install
```

### 1. Create the Google Cloud project

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, for example `google-health-mcp`.
2. Enable the [Google Health API](https://console.cloud.google.com/apis/library/health.googleapis.com) in that project.
3. Open **Google Auth Platform** and click **Get started**. Give the app a name (people see it on Google's consent screen), set a support email, and choose **External** as the audience.
4. Under **Data access → Add or remove scopes**, add these four scopes:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/googlehealth.sleep.readonly`
   - `.../auth/googlehealth.health_metrics_and_measurements.readonly`
5. Under **Audience**, click **Publish app** to set it **In production**. Google doesn't need to verify it for up to 100 users.

> [!IMPORTANT]
> While the app is in **Testing**, Google's refresh tokens expire after 7 days, so everyone has to reconnect weekly. Once it's published, it stays unverified: sign-in shows "Google hasn't verified this app", and people continue with **Advanced → Go to (app name)**. Google Health scopes are restricted, so getting verified takes a security review. That's only worth it past 100 users.

### 2. Deploy

```bash
npm run deploy
```

Confirm the changeset when asked. The output ends with two values:

- `McpServerUrl`, which people add to claude.ai.
- `GoogleRedirectUri`, which the Google OAuth client needs next.

`sam list stack-outputs` shows them again later.

### 3. Create the Google OAuth client

1. In Google Auth Platform, go to **Clients → Create client** and choose application type **Web application**.
2. Under **Authorized redirect URIs**, add the `GoogleRedirectUri` from the deploy output. It ends in `/oauth/callback`.
3. Create the client and download its JSON file.
4. Store the client in SSM, then delete the downloaded file:
   ```bash
   npm run admin -- google-client path/to/client_secret_....json
   ```
5. Allow your own Google account to connect:
   ```bash
   npm run admin -- allow you@gmail.com
   ```

### 4. Connect Claude

In claude.ai, go to **Settings → Connectors → Add custom connector** and paste the `McpServerUrl` (it ends in `/mcp`). Click **Connect** and sign in with Google. On the consent screen, allow both sleep data and health metrics.

The connector then works on web and mobile, and in Claude Desktop. To use it in a training-coach project, enable it in that project's chat.

## Adding someone

1. Run `npm run admin -- allow their@gmail.com` with the Google account that holds their Fitbit data.
2. Send them the `McpServerUrl`. They add the connector in their own claude.ai account and sign in with Google. On the Free plan, claude.ai allows one custom connector.

Each person sees only their own data. Their Google tokens are stored nowhere on the server; they travel inside the encrypted tokens Claude holds for their connection.

## Day to day

| Task | Command |
|------|---------|
| Deploy code changes | `npm run deploy` |
| Show the Google client and who can connect | `npm run admin -- list` |
| Let someone connect | `npm run admin -- allow <email>` |
| Stop someone connecting (signs them out) | `npm run admin -- deny <email>` |
| Replace the Google OAuth client | `npm run admin -- google-client <file.json>` |
| Sign everyone out | `npm run admin -- sign-out-all` |
| Show the URLs | `sam list stack-outputs` |
| Remove everything | `sam delete`, then `aws ssm delete-parameters --names /google-health-mcp/MCP_SIGNING_SECRET /google-health-mcp/ALLOWED_EMAILS /google-health-mcp/GOOGLE_CLIENT_ID /google-health-mcp/GOOGLE_CLIENT_SECRET` |

Lambda reads its settings once per cold start, so every `admin` change also replaces the function's running instances. That way changes take effect immediately.

People can also remove the server's access themselves, under [Google Account → Third-party connections](https://myaccount.google.com/connections). Claude then asks them to connect again.

## How it works

- **Sign-in:** claude.ai custom connectors only support OAuth, so the server is a small OAuth server that passes sign-in on to Google. When someone connects, the server sends their browser to Google's consent screen. It then checks their Google email against the allowlist and hands Claude a code.
- **Tokens:** Claude's access token carries the person's Google access token, and its refresh token carries their Google refresh token, all encrypted (AES-256-GCM) with a key only the server has. Every hour Claude refreshes its token, and the server gets a new Google access token. If Google no longer accepts the grant, Claude asks the person to reconnect.
- **No database:** nothing is stored per person. The signing secret, the allowlist and the Google OAuth client are SecureString parameters in SSM Parameter Store, so they never appear in the function's configuration or in the repo.
- **Data:** tools use the Google Health API's `reconcile` endpoint, which merges data from all sources (Fitbit, Pixel Watch, Health Connect apps) so a night isn't counted twice.
- **Cost:** normally $0, within Lambda's always-free allowance (1M requests and 400,000 GB-seconds a month). Set up an AWS budget alert anyway.

## Running locally

For testing, or for MCP clients on your own machine, the same server runs locally with settings from `.env`:

1. Add `http://localhost:3000/oauth/callback` to the Google OAuth client's authorized redirect URIs.
2. Copy `.env.example` to `.env` and fill it in.
3. Run:
   ```bash
   npm run build
   npm start
   ```

The server listens on `http://localhost:3000/mcp`. For example: `claude mcp add --transport http google-health http://localhost:3000/mcp`.

## Known limitations

- **Data freshness:** data only reaches Google after the watch syncs with the Fitbit app, and some metrics (HRV, skin temperature) are computed a while after waking. This morning's values can be missing at first.
- **Reconnecting:** Google ends grants after 7 days while the app is in Testing, and after 6 months without use. Some integrations also report grants ending unexpectedly ([home-assistant/core#182964](https://github.com/home-assistant/core/issues/182964)). In all these cases Claude asks you to connect again.
- **Unverified app:** see the note in step 1. The limit is 100 people.

## License

MIT
