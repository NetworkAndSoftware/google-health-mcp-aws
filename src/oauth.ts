import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { GoogleGrantError, GoogleOAuth, HEALTH_SCOPES, type GoogleClientConfig, type GoogleSignIn, type GoogleTokens } from "./google-oauth.js";
import { now, Sealer } from "./seal.js";

// OAuth server for claude.ai custom connectors, which only support OAuth or no auth. Signing in
// is delegated to Google: authorize() sends the browser to Google's consent screen, and Google
// returns to /oauth/callback, where the person's Google account is checked against the allowlist
// before Claude gets an authorization code.
//
// Everything is stateless so it runs on Lambda without a database: client IDs, codes and tokens
// are sealed (encrypted) claims. Access tokens carry the person's Google access token, and
// refresh tokens their Google refresh token, which is exchanged for a new Google access token
// whenever Claude refreshes. The trade-offs: a single token can't be revoked (removing an email
// from the allowlist signs that person out, and changing MCP_SIGNING_SECRET signs out everyone),
// and codes can't be marked as used, so they're short-lived and PKCE-bound instead.

export const CALLBACK_PATH = "/oauth/callback";

const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour, like Google's access tokens
// Renewed on every refresh. Google drops refresh tokens that go unused for 6 months.
const REFRESH_TOKEN_TTL = 180 * 24 * 60 * 60;
const CODE_TTL = 2 * 60;
const SIGN_IN_TTL = 10 * 60;

// Bump the version if a claims type changes incompatibly: older values then fail to open
const KIND = {
  client: "google-health-mcp/v1/client",
  signIn: "google-health-mcp/v1/sign-in",
  code: "google-health-mcp/v1/code",
  access: "google-health-mcp/v1/access",
  refresh: "google-health-mcp/v1/refresh",
};

type ClientClaims = { r: string[]; m: string; exp?: never };
// An authorization request from Claude, round-tripped through Google as the state parameter
type SignInClaims = { cid: string; ru: string; cc: string; st?: string; sc: string[]; exp: number };
type CodeClaims = { cid: string; ru: string; cc: string; sc: string[]; email: string; grt: string; gat: string; gexp: number; exp: number };
type AccessClaims = { cid: string; sc: string[]; email: string; gat: string; exp: number };
type RefreshClaims = { cid: string; sc: string[]; email: string; grt: string; exp: number };

export type GoogleSignInOptions = {
  google: GoogleClientConfig;
  // Google account emails that may connect
  allowedEmails: string[];
  signingSecret: string;
  // Redirect URIs a client may register, e.g. claude.ai's connector callback
  redirectUris: string[];
  // The MCP endpoint these tokens are for
  resourceUrl: URL;
};

export class GoogleSignInProvider implements OAuthServerProvider {
  private sealer: Sealer;
  private google: GoogleOAuth;
  private allowedEmails: Set<string>;
  // Must be registered as an authorized redirect URI of the Google OAuth client
  private callbackUrl: string;

  constructor(private options: GoogleSignInOptions) {
    this.sealer = new Sealer(options.signingSecret);
    this.google = new GoogleOAuth(options.google);
    this.allowedEmails = new Set(options.allowedEmails.map((email) => email.toLowerCase()));
    this.callbackUrl = new URL(CALLBACK_PATH, options.resourceUrl).href;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => {
        const disallowed = client.redirect_uris.filter((uri) => !this.options.redirectUris.includes(uri));
        if (disallowed.length > 0) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${disallowed.join(", ")}`);
        }
        const method = client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_post" : "none");
        const clientId = this.sealer.seal(KIND.client, { r: client.redirect_uris, m: method } satisfies ClientClaims);
        return { ...client, ...this.getClient(clientId)!, client_id_issued_at: now() };
      },
    };
  }

  private getClient(clientId: string): OAuthClientInformationFull | undefined {
    const claims = this.sealer.open<ClientClaims>(KIND.client, clientId);
    if (!claims) return undefined;
    return {
      client_id: clientId,
      redirect_uris: claims.r.filter((uri) => this.options.redirectUris.includes(uri)),
      token_endpoint_auth_method: claims.m,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Confidential clients get a secret derived from their ID, so it needn't be stored
      ...(claims.m === "none"
        ? {}
        : { client_secret: this.sealer.mac(`secret:${clientId}`), client_secret_expires_at: 0 }),
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const state = this.sealer.seal(KIND.signIn, {
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes ?? [],
      exp: now() + SIGN_IN_TTL,
    } satisfies SignInClaims);
    res.set("Cache-Control", "no-store").redirect(302, this.google.authorizationUrl(this.callbackUrl, state));
  }

  // GET /oauth/callback: Google returns here after its consent screen
  async handleCallback(req: Request, res: Response): Promise<void> {
    const signIn = this.sealer.open<SignInClaims>(KIND.signIn, typeof req.query.state === "string" ? req.query.state : "");
    if (!signIn || !this.getClient(signIn.cid)?.redirect_uris.includes(signIn.ru)) {
      this.sendPage(res.status(400), "This sign-in link has expired. Start connecting again from Claude.");
      return;
    }
    const returnToClient = (params: Record<string, string>) => {
      const target = new URL(signIn.ru);
      for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
      if (signIn.st !== undefined) target.searchParams.set("state", signIn.st);
      res.set("Cache-Control", "no-store").redirect(302, target.href);
    };

    if (typeof req.query.error === "string") {
      // access_denied: the person cancelled on Google's consent screen
      returnToClient({ error: req.query.error === "access_denied" ? "access_denied" : "server_error", error_description: `Google sign-in failed: ${req.query.error}` });
      return;
    }
    const googleCode = typeof req.query.code === "string" ? req.query.code : "";
    let google: GoogleSignIn;
    try {
      google = await this.google.exchangeCode(googleCode, this.callbackUrl);
    } catch (error) {
      console.error("Google sign-in failed:", error);
      this.sendPage(res.status(502), "Couldn't complete the sign-in with Google. Start connecting again from Claude.");
      return;
    }

    const problem = this.checkSignIn(google);
    if (problem) {
      this.sendPage(res.status(403), problem);
      return;
    }
    const code = this.sealer.seal(KIND.code, {
      cid: signIn.cid,
      ru: signIn.ru,
      cc: signIn.cc,
      sc: signIn.sc,
      email: google.email,
      grt: google.refreshToken!,
      gat: google.accessToken,
      gexp: google.expiresAt,
      exp: now() + CODE_TTL,
    } satisfies CodeClaims);
    returnToClient({ code });
  }

  private checkSignIn(google: GoogleSignIn): string | undefined {
    if (!google.emailVerified || !this.isAllowed(google.email)) {
      // Nobody should keep a grant they can't use
      this.google.revoke(google.refreshToken ?? google.accessToken).catch((error) => console.error("Revoking Google access failed:", error));
      return `${google.email || "This Google account"} isn't allowed to use this server. Ask the person who runs it to add your Google account's email address.`;
    }
    if (HEALTH_SCOPES.some((scope) => !google.grantedScopes.includes(scope))) {
      return "Claude needs access to both your sleep data and your health metrics. Start connecting again from Claude, and allow all the requested data on Google's consent screen.";
    }
    if (!google.refreshToken) {
      return "Google didn't grant lasting access. Remove this app under Google Account > Security > Third-party connections, then start connecting again from Claude.";
    }
    return undefined;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.verifyCode(client, authorizationCode).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const claims = this.verifyCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== claims.ru) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.checkResource(resource);
    return this.issueTokens(client.client_id, claims, claims.grt, { accessToken: claims.gat, expiresAt: claims.gexp });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const claims = this.sealer.open<RefreshClaims>(KIND.refresh, refreshToken);
    if (!claims || claims.cid !== client.client_id || !this.isAllowed(claims.email)) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    this.checkResource(resource);

    // Also checks the Google grant still works, so Claude asks the person to connect again once
    // it doesn't. Other failures (Google unreachable) leave the refresh token usable for a retry.
    let google: GoogleTokens;
    try {
      google = await this.google.refresh(claims.grt);
    } catch (error) {
      if (error instanceof GoogleGrantError) {
        console.warn(`Google access for ${claims.email} ended:`, error.message);
        throw new InvalidGrantError("Google access has expired or was revoked; connect again");
      }
      console.error("Google token refresh failed:", error);
      throw new ServerError("Couldn't reach Google; try again");
    }
    return this.issueTokens(client.client_id, claims, google.refreshToken ?? claims.grt, google);
  }

  // AuthInfo.extra carries the signed-in person's email and Google access token
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = this.sealer.open<AccessClaims>(KIND.access, token);
    if (!claims || !this.isAllowed(claims.email)) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: claims.cid,
      scopes: claims.sc,
      expiresAt: claims.exp,
      resource: this.options.resourceUrl,
      extra: { email: claims.email, googleAccessToken: claims.gat },
    };
  }

  private verifyCode(client: OAuthClientInformationFull, code: string): CodeClaims {
    const claims = this.sealer.open<CodeClaims>(KIND.code, code);
    if (!claims || claims.cid !== client.client_id || !this.isAllowed(claims.email)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return claims;
  }

  private isAllowed(email: string): boolean {
    return this.allowedEmails.has(email);
  }

  private checkResource(resource: URL | undefined) {
    if (resource && resource.href !== this.options.resourceUrl.href) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.options.resourceUrl.href}`);
    }
  }

  private issueTokens(clientId: string, { sc, email }: { sc: string[]; email: string }, googleRefreshToken: string, google: GoogleTokens): OAuthTokens {
    const issuedAt = now();
    // Expire before the Google access token inside, so Claude refreshes both together
    const expiresAt = Math.min(issuedAt + ACCESS_TOKEN_TTL, google.expiresAt - 60);
    return {
      access_token: this.sealer.seal(KIND.access, { cid: clientId, sc, email, gat: google.accessToken, exp: expiresAt } satisfies AccessClaims),
      token_type: "Bearer",
      expires_in: expiresAt - issuedAt,
      refresh_token: this.sealer.seal(KIND.refresh, {
        cid: clientId,
        sc,
        email,
        grt: googleRefreshToken,
        exp: issuedAt + REFRESH_TOKEN_TTL,
      } satisfies RefreshClaims),
      ...(sc.length > 0 ? { scope: sc.join(" ") } : {}),
    };
  }

  private sendPage(res: Response, message: string) {
    res
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      })
      .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Google Health MCP</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1b1d21; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141518; --card: #202226; --text: #eceef1; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(420px, calc(100vw - 32px)); background: var(--card); border-radius: 12px; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 8px; }
</style>
</head>
<body><main><h1>Google Health MCP</h1><p>${escapeHtml(message)}</p></main></body>
</html>`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
