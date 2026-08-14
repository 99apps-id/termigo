// OAuth preset catalog — presentation and upstream-call metadata for the three
// account-based providers Termigo supports: Codex (OpenAI), Claude
// (Anthropic), and Antigravity (Google Cloud Code).
//
// The OAuth *protocol* values (client id, client secret, authorize/token URLs,
// scopes, redirect URI, loopback port, PKCE) deliberately live ONLY in
// `src-tauri/src/modules/oauth.rs`. Everything in the renderer ends up in the
// shipped JS bundle, so mirroring them here published a client secret to every
// user and gave the flow two sources of truth that could drift. The frontend
// never needs them: it calls `oauth_start`, which returns the authorize URL
// already built by the backend.

export type OAuthProfile = "codex" | "claude" | "antigravity";

/**
 * The renderer's view of a signed-in account, mirroring Rust's `OAuthSession`.
 *
 * There is deliberately no `refresh_token` field: the full token set stays in
 * the OS keyring on the Rust side, and renewal happens there too
 * (`oauth_session`), so the long-lived credential never reaches the webview.
 */
export type OAuthSession = {
  access_token: string;
  /** Absolute unix seconds when the access token expires (computed locally). */
  expires_at?: number | null;
  scope?: string | null;
  project_id?: string | null;
};

export type OAuthPreset = {
  profile: OAuthProfile;
  displayName: string;
  shortName: string;
  tagline: string;
  /** Gradient used for the account tile in the UI. */
  tile: string;
  /**
   * Manual-code flow: the browser shows a code the user pastes back (claude),
   * instead of redirecting to a local loopback listener. Drives which controls
   * the sign-in card renders. The backend reports the same value on
   * `oauth_start`; this copy only decides the initial UI shape.
   */
  manualCode: boolean;
  /** Base URL for the upstream inference call once signed in. */
  baseUrl: string;
  defaultModelLabel: string;
  /** Vendor headers the upstream API expects on inference requests. */
  upstreamHeaders: Record<string, string>;
};

export const OAUTH_PRESETS: Record<OAuthProfile, OAuthPreset> = {
  codex: {
    profile: "codex",
    displayName: "Codex",
    shortName: "Codex",
    tagline: "ChatGPT plan · OpenAI",
    tile: "from-[#10a37f] to-[#0d9488]",
    manualCode: false,
    // Base only: @ai-sdk/openai appends its own "/responses" path. Including it
    // here produced ".../codex/responses/responses", whose 404 HTML page failed
    // JSON parsing as `Unexpected token '<', "<!DOCTYPE "...`.
    baseUrl: "https://chatgpt.com/backend-api/codex",
    defaultModelLabel: "GPT-5.6",
    upstreamHeaders: {
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.136.0",
    },
  },
  claude: {
    profile: "claude",
    displayName: "Claude",
    shortName: "Claude",
    tagline: "Anthropic subscription",
    tile: "from-[#d97757] to-[#c26a4d]",
    manualCode: true,
    // Base only, for the same reason as Codex: @ai-sdk/anthropic appends
    // "/messages". Currently unused (the Claude path takes the provider
    // default) but wrong values here become bugs the moment someone wires it up.
    baseUrl: "https://api.anthropic.com/v1",
    defaultModelLabel: "Claude Sonnet 5",
    upstreamHeaders: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  },
  antigravity: {
    profile: "antigravity",
    displayName: "Antigravity",
    shortName: "Antigravity",
    tagline: "Google Cloud Code",
    tile: "from-[#4285f4] to-[#34a853]",
    manualCode: false,
    baseUrl: "https://cloudcode-pa.googleapis.com/v1internal",
    defaultModelLabel: "Gemini 3 Flash",
    upstreamHeaders: {
      "User-Agent": "antigravity/ide/2.1.1",
      "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    },
  },
};

export const OAUTH_PROFILES: readonly OAuthProfile[] = [
  "codex",
  "claude",
  "antigravity",
];

/**
 * Which OAuth profile can stand in for a provider's API key.
 *
 * Signing in supplies the credential that provider would otherwise need, so
 * anything asking "is this provider usable?" has to consult this as well as the
 * stored keys, or a connected account still looks unconfigured.
 */
export const OAUTH_PROFILE_FOR_PROVIDER: Readonly<
  Record<string, OAuthProfile>
> = {
  openai: "codex",
  anthropic: "claude",
  google: "antigravity",
};

export function oauthProfileLabel(profile: OAuthProfile): string {
  return OAUTH_PRESETS[profile].displayName;
}
