// Google's OAuth endpoints, for signing people in and getting tokens for the Google Health API.
// The Google OAuth client (a "Web application" client in Google Cloud) is the server operator's;
// each person who connects grants it read access to their own data.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const HEALTH_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
];
// openid and email identify who signed in, for the allowlist
const SCOPES = ["openid", "email", ...HEALTH_SCOPES];

export type GoogleClientConfig = { clientId: string; clientSecret: string };

export type GoogleTokens = {
  accessToken: string;
  // Seconds since the epoch
  expiresAt: number;
  // Only returned when the user signs in (and, rarely, when Google rotates it)
  refreshToken?: string;
};

export type GoogleSignIn = GoogleTokens & {
  email: string;
  emailVerified: boolean;
  grantedScopes: string[];
};

// Google no longer accepts the refresh token: it expired, the user revoked access, or the
// OAuth client changed. The user has to connect again.
export class GoogleGrantError extends Error {}

export class GoogleOAuth {
  constructor(private config: GoogleClientConfig) {}

  authorizationUrl(redirectUri: string, state: string): string {
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      // A refresh token, so Claude can keep using the connection
      access_type: "offline",
      // Show the consent screen every time, so Google always returns a refresh token
      prompt: "consent",
      state,
    }).toString();
    return url.href;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GoogleSignIn> {
    const body = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (typeof body.id_token !== "string") throw new Error("Google didn't return an ID token");
    // The ID token comes straight from Google's token endpoint over TLS, so its signature
    // needn't be checked (https://developers.google.com/identity/openid-connect/openid-connect#obtainuserinfo)
    const identity = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString());
    return {
      ...this.tokens(body),
      email: String(identity.email ?? "").toLowerCase(),
      emailVerified: identity.email_verified === true,
      grantedScopes: String(body.scope ?? "").split(" "),
    };
  }

  async refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.tokens(await this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }));
  }

  // Revoking either token ends the whole grant, so it disappears from the user's
  // Google Account > Third-party connections
  async revoke(token: string): Promise<void> {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    // 400 means the token was already invalid
    if (!res.ok && res.status !== 400) throw new Error(`Google token revocation failed: HTTP ${res.status}`);
  }

  private tokens(body: Record<string, unknown>): GoogleTokens {
    if (typeof body.access_token !== "string") throw new Error("Google didn't return an access token");
    return {
      accessToken: body.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + Number(body.expires_in ?? 3600),
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    };
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...params,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body;

    const error = String(body.error ?? `HTTP ${res.status}`);
    const description = body.error_description ? `: ${body.error_description}` : "";
    // unauthorized_client: the grant belongs to a different (replaced) OAuth client
    if (error === "invalid_grant" || error === "unauthorized_client") {
      throw new GoogleGrantError(`Google refused the grant (${error}${description})`);
    }
    throw new Error(`Google token request failed (${error}${description})`);
  }
}
