import crypto from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { readNotionAuth, writeNotionAuth, type NotionAuthFile } from "./store.ts";

/**
 * True when the stored dynamic client registration was made for a different
 * redirect URL (the app moved ports), so a NEW authorization must re-register.
 * Existing tokens stay usable: refreshing them only needs the old client_id.
 */
export function registrationNeedsReset(auth: NotionAuthFile, redirectUrl: string): boolean {
  return !!auth.client_information && auth.redirect_url !== redirectUrl;
}

/**
 * Before starting a new authorization: drop a registration made for another
 * redirect URL (plus its in-flight PKCE verifier and state) so the SDK
 * registers a fresh client for this one. Tokens are kept.
 */
export function resetRegistrationIfRedirectChanged(redirectUrl: string): boolean {
  const auth = readNotionAuth();
  if (!registrationNeedsReset(auth, redirectUrl)) return false;
  const { client_information: _c, code_verifier: _v, state: _s, ...rest } = auth;
  writeNotionAuth({ ...rest, redirect_url: redirectUrl });
  return true;
}

/**
 * OAuth client for Notion's hosted MCP server, persisted to
 * ~/.skill-vault/notion-auth.json so the PKCE verifier and the dynamically
 * registered client survive the browser round trip. `redirect_url` records
 * the redirect the stored client was registered with; a mismatch never drops
 * tokens or client info here (see resetRegistrationIfRedirectChanged).
 */
export function createNotionAuthProvider(
  redirectUrl: string,
): OAuthClientProvider & { pendingAuthUrl(): string | undefined } {
  let pending: string | undefined;
  const load = (): NotionAuthFile => readNotionAuth();
  const save = (patch: Partial<NotionAuthFile>) => writeNotionAuth({ ...load(), ...patch });

  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "Skill Vault",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state() {
      const s = crypto.randomBytes(16).toString("hex");
      save({ state: s });
      return s;
    },
    clientInformation() {
      return load().client_information as OAuthClientInformationMixed | undefined;
    },
    saveClientInformation(info) {
      save({ client_information: info, redirect_url: redirectUrl });
    },
    tokens() {
      return load().tokens as OAuthTokens | undefined;
    },
    saveTokens(tokens) {
      save({ tokens });
    },
    redirectToAuthorization(url) {
      pending = url.toString();
    },
    saveCodeVerifier(v) {
      save({ code_verifier: v });
    },
    codeVerifier() {
      const v = load().code_verifier;
      if (!v) throw new Error("no PKCE code verifier saved — start the Notion connection again");
      return v;
    },
    invalidateCredentials(scope) {
      const a = load();
      if (scope === "all") writeNotionAuth({});
      else if (scope === "client") writeNotionAuth({ ...a, client_information: undefined });
      else if (scope === "tokens") writeNotionAuth({ ...a, tokens: undefined });
      else if (scope === "verifier") writeNotionAuth({ ...a, code_verifier: undefined });
    },
    pendingAuthUrl() {
      return pending;
    },
  };
}
