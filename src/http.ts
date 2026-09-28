import express, { type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { GoogleHealthClient } from "./api.js";
import type { GoogleClientConfig } from "./google-oauth.js";
import { CALLBACK_PATH, GoogleSignInProvider } from "./oauth.js";
import { createMcpServer } from "./server.js";

export type HttpConfig = {
  google: GoogleClientConfig;
  allowedEmails: string[];
  signingSecret: string;
  redirectUris: string[];
  // Public origin, e.g. http://localhost:3000. When unset, it's taken from the Host header,
  // which is only trusted for Lambda function URLs (AWS routes on it, so it can't be spoofed)
  publicUrl?: string;
};

const LAMBDA_URL_HOST = /^[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function redirectUrisFromEnv(value: string | undefined): string[] {
  const uris = (value ?? "").split(",").map((uri) => uri.trim()).filter(Boolean);
  return uris.length > 0 ? uris : ["https://claude.ai/api/mcp/auth_callback"];
}

// The ALLOWED_EMAILS setting: a JSON array (as scripts/admin.mjs writes it) or a comma-separated list
export function parseAllowedEmails(value: string): string[] {
  const text = value.trim();
  const items: unknown = text.startsWith("[") ? JSON.parse(text) : text.split(",");
  if (!Array.isArray(items)) throw new Error("ALLOWED_EMAILS must be a JSON array or a comma-separated list");
  const emails = items.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const invalid = emails.filter((email) => !EMAIL.test(email));
  if (invalid.length > 0) throw new Error(`Not valid email addresses: ${invalid.join(", ")}`);
  return emails;
}

export function createHttpApp(config: HttpConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // One hop: Lambda's function URL front end (or none locally), for the rate limiters' client IP
  app.set("trust proxy", 1);

  // The OAuth metadata embeds absolute URLs, so the routes are built once the origin is known
  let routes: { origin: string; router: express.Router } | undefined;
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    const origin = config.publicUrl ?? (LAMBDA_URL_HOST.test(host) ? `https://${host}` : undefined);
    if (!origin) {
      res.status(421).send("Unrecognized host; set PUBLIC_URL");
      return;
    }
    routes ??= { origin, router: createRoutes(config, origin) };
    if (routes.origin !== origin) {
      res.status(421).send("Misdirected request");
      return;
    }
    routes.router(req, res, next);
  });

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = typeof error?.status === "number" ? error.status : 500;
    if (status >= 500) console.error("Request failed:", error);
    res.status(status).json({ error: status >= 500 ? "server_error" : "invalid_request" });
  };
  app.use(onError);

  return app;
}

function createRoutes(config: HttpConfig, origin: string): express.Router {
  const router = express.Router();
  const mcpUrl = new URL("/mcp", origin);
  const provider = new GoogleSignInProvider({
    google: config.google,
    allowedEmails: config.allowedEmails,
    signingSecret: config.signingSecret,
    redirectUris: config.redirectUris,
    resourceUrl: mcpUrl,
  });

  // The rate limiters warn when created inside a request handler, which these are, once per
  // instance, because the origin isn't known until the first request
  const rateLimitOptions = { validate: { creationStack: false } };
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(origin),
      resourceServerUrl: mcpUrl,
      resourceName: "Google Health",
      authorizationOptions: { rateLimit: rateLimitOptions },
      tokenOptions: { rateLimit: rateLimitOptions },
      clientRegistrationOptions: { rateLimit: rateLimitOptions },
    })
  );

  router.get(
    CALLBACK_PATH,
    rateLimit({ ...rateLimitOptions, windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }),
    (req, res, next) => provider.handleCallback(req, res).catch(next)
  );

  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  router.post("/mcp", requireAuth, express.json({ limit: "1mb" }), async (req, res) => {
    // Each request acts for whoever signed in, with the Google access token their token carries
    const client = new GoogleHealthClient(String(req.auth?.extra?.googleAccessToken));
    // Stateless: a fresh server and transport per request, so any Lambda instance can serve any call
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // No sessions, so there's no SSE stream to GET and nothing to DELETE
  router.all("/mcp", requireAuth, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return router;
}
