// OAuth preset catalog — ported from the NesaRouter `oauthProviderPresets`
// metadata for the three account-based providers Termigo supports:
// Codex (OpenAI), Claude (Anthropic), and Antigravity (Google Cloud Code).
//
// The Rust backend (`src-tauri/src/modules/oauth.rs`) mirrors these values
// for the actual token exchange; this file is the single source of truth for
// the UI and for the model wiring in `buildLanguageModel`.

export type OAuthProfile = "codex" | "claude" | "antigravity";

export type OAuthTokens = {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number | null;
  token_type?: string | null;
  scope?: string | null;
  /** Absolute unix seconds when the access token expires (computed locally). */
  expires_at?: number | null;
  project_id?: string | null;
};

export type OAuthPreset = {
  profile: OAuthProfile;
  displayName: string;
  shortName: string;
  tagline: string;
  /** Gradient used for the account tile in the UI. */
  tile: string;
  clientId: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** true = JSON body on the token endpoint; false = form-encoded. */
  jsonBody: boolean;
  redirectUri: string;
  /** Loopback listener port (codex/antigravity); null for manual-code flows. */
  loopbackPort: number | null;
  /** Manual-code flow: browser shows a code the user pastes back (claude). */
  manualCode: boolean;
  extraAuthorizeParams: Record<string, string>;
  baseUrl: string;
  defaultModel: string;
  defaultModelLabel: string;
  upstreamHeaders: Record<string, string>;
};

export const OAUTH_PRESETS: Record<OAuthProfile, OAuthPreset> = {
  codex: {
    profile: "codex",
    displayName: "Codex",
    shortName: "Codex",
    tagline: "ChatGPT plan · OpenAI",
    tile: "from-[#10a37f] to-[#0d9488]",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    jsonBody: false,
    redirectUri: "http://localhost:1455/auth/callback",
    loopbackPort: 1455,
    manualCode: false,
    extraAuthorizeParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    defaultModel: "gpt-5.6-sol",
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
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scope: "org:create_api_key user:profile user:inference",
    jsonBody: true,
    redirectUri: "https://console.anthropic.com/oauth/code/callback",
    loopbackPort: null,
    manualCode: true,
    extraAuthorizeParams: { code: "true" },
    baseUrl: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-sonnet-5",
    defaultModelLabel: "Claude Sonnet 5",
    upstreamHeaders: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  },
  antigravity: {
    profile: "antigravity",
    displayName: "Antigravity",
    shortName: "Antigravity",
    tagline: "Google Cloud Code",
    tile: "from-[#4285f4] to-[#34a853]",
    clientId:
      "REDACTED_SUPPLIED_AT_BUILD_TIME",
    clientSecret: "REDACTED_SUPPLIED_AT_BUILD_TIME",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ].join(" "),
    jsonBody: false,
    redirectUri: "http://127.0.0.1:51121/oauth2callback",
    loopbackPort: 51121,
    manualCode: false,
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
    baseUrl: "https://cloudcode-pa.googleapis.com/v1internal",
    defaultModel: "gemini-3-flash",
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

export function oauthProfileLabel(profile: OAuthProfile): string {
  return OAUTH_PRESETS[profile].displayName;
}
