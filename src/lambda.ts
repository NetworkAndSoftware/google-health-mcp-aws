import type { IncomingMessage } from "node:http";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import serverless from "serverless-http";
import { createHttpApp, parseAllowedEmails, redirectUrisFromEnv } from "./http.js";

// AWS Lambda entry point, bundled by scripts/build-lambda.mjs and deployed with template.yaml.
// Settings are SecureString parameters in SSM Parameter Store (managed with scripts/admin.mjs),
// read once per cold start, so they never appear in the function's configuration.

const SETTING_NAMES = ["MCP_SIGNING_SECRET", "ALLOWED_EMAILS", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
type SettingName = (typeof SETTING_NAMES)[number];

const prefix = process.env.SSM_PREFIX ?? "/google-health-mcp";
const { Parameters = [], InvalidParameters = [] } = await new SSMClient({}).send(
  new GetParametersCommand({ Names: SETTING_NAMES.map((name) => `${prefix}/${name}`), WithDecryption: true })
);
if (InvalidParameters.length > 0) {
  throw new Error(
    `Missing SSM parameters: ${InvalidParameters.join(", ")}. Set them with npm run admin -- google-client and npm run admin -- allow.`
  );
}
const settings = Object.fromEntries(
  Parameters.map((parameter) => [parameter.Name!.slice(prefix.length + 1), parameter.Value!])
) as Record<SettingName, string>;

const app = createHttpApp({
  google: { clientId: settings.GOOGLE_CLIENT_ID, clientSecret: settings.GOOGLE_CLIENT_SECRET },
  allowedEmails: parseAllowedEmails(settings.ALLOWED_EMAILS),
  signingSecret: settings.MCP_SIGNING_SECRET,
  redirectUris: redirectUrisFromEnv(process.env.OAUTH_REDIRECT_URIS),
  publicUrl: process.env.PUBLIC_URL || undefined,
});

export const handler = serverless(app, {
  // The MCP SDK's HTTP transport reads rawHeaders (via @hono/node-server), which serverless-http leaves empty
  request(req: IncomingMessage) {
    req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [String(value)]).flatMap((v) => [name, v])
    );
  },
});
