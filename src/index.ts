import "dotenv/config";
import { createHttpApp, parseAllowedEmails, redirectUrisFromEnv } from "./http.js";

// Local run of the server that Lambda hosts (src/lambda.ts), with settings from .env instead of
// SSM. For testing, or for MCP clients on this machine: http://localhost:3000/mcp. The Google
// OAuth client needs http://localhost:3000/oauth/callback as an authorized redirect URI.

const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MCP_SIGNING_SECRET", "ALLOWED_EMAILS"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")} in the environment. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const app = createHttpApp({
  google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
  allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS!),
  signingSecret: process.env.MCP_SIGNING_SECRET!,
  redirectUris: redirectUrisFromEnv(process.env.OAUTH_REDIRECT_URIS),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
});
app.listen(port, () => console.error(`Google Health MCP server listening on http://localhost:${port}/mcp`));
