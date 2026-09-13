// Secret-scanning pass over unified diff text.
//
// The goal is not to build a perfect secret scanner - that lives in the
// language-model layer - but to prevent obvious credential leakage in the
// source-control UI and in AI commit-message prompts. Patterns are chosen to
// match the high-value leaks we actually see in diffs: env files, keys, and
// inline credentials.

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  // .env-style values on a = or : line (avoids matching URLs)
  {
    name: "env-value",
    re: /^(.*?[\s=:]\s*)([A-Za-z_][A-Za-z0-9_]{0,31}\s*[=:]\s*)(.+)$/,
  },
  // AWS key id
  { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub token
  { name: "github-token", re: /\bghp_[A-Za-z0-9_]{36}\b/g },
  { name: "github-oauth", re: /\bgho_[A-Za-z0-9_]{36}\b/g },
  // Generic private key block
  {
    name: "private-key",
    re: /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE KEY-----/g,
  },
  // PEM header
  {
    name: "pem",
    re: /-----BEGIN\s+[A-Z ]+-----\n[\s\S]*?-----END\s+[A-Z ]+-----/g,
  },
  // netrc password lines
  { name: "netrc-password", re: /^\s*password\s+\S+$/gim },
  // .npmrc auth tokens
  { name: "npmrc-auth", re: /^(\s*_\?auth\s*=\s*).+$/gim },
  // Slack token
  { name: "slack-token", re: /\bxox[baprs]-[0-9a-zA-Z-]+\b/g },
  // Google service account
  {
    name: "gcp-key",
    re: /"type"\s*:\s*"service_account"[\s\S]*?"private_key"\s*:\s*"-----/g,
  },
  // Password in URL
  { name: "url-password", re: /\/\/[^:]+:[^@]+@/g },
  // Stripe secret key
  { name: "stripe-key", re: /\bsk_live_[0-9a-zA-Z]{24,}\b/g },
  // SendGrid API key
  { name: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
];

// Maximum number of redactions before we bail out and return a generic
// "secrets redacted" string to avoid sending huge blobs of redacted text.
const MAX_REDACTIONS = 40;

export interface SanitizeDiffResult {
  text: string;
  redacted: boolean;
  redactionCount: number;
  patterns: string[];
}

export function sanitizeDiff(input: string): SanitizeDiffResult {
  let text = input;
  let totalRedactions = 0;
  const hitPatterns = new Set<string>();

  for (const { name, re } of PATTERNS) {
    let count = 0;
    text = text.replace(re, () => {
      count++;
      totalRedactions++;
      hitPatterns.add(name);
      if (totalRedactions > MAX_REDACTIONS) {
        return "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }

  // Env-style: mask values after = or : when the key looks like a secret
  // variable. Run after the generic patterns above so we don't double-count.
  if (totalRedactions <= MAX_REDACTIONS) {
    const envKeyRe =
      /(?:^|[\s=:])(?:API[_-]?KEY|AUTH[_-]?TOKEN|SECRET[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD|PASSWD|TOKEN|CREDENTIAL|DB[_-]?PASS|DATABASE[_-]?URL|CLIENT[_-]?SECRET)\s*[=:]\s*(.+)/gi;
    text = text.replace(envKeyRe, (match, prefix, value) => {
      const trimmed = value.trim();
      if (
        trimmed.length > 0 &&
        !trimmed.startsWith("[REDACTED]") &&
        !trimmed.startsWith("$") &&
        !trimmed.startsWith("${")
      ) {
        totalRedactions++;
        hitPatterns.add("env-key");
        return `${prefix}[REDACTED]`;
      }
      return match;
    });
  }

  return {
    text,
    redacted: totalRedactions > 0,
    redactionCount: totalRedactions,
    patterns: [...hitPatterns],
  };
}

export function secretWarning(patterns: string[]): string {
  if (patterns.length === 0) return "";
  const list = [...new Set(patterns)].join(", ");
  return `Potential secret detected and redacted (${list}). Review before sharing.`;
}
