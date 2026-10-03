import { OAuthProviderCard } from "./OAuthProviderCard";

/**
 * Sign in with a ChatGPT account instead of pasting an API key.
 * Backwards-compatible export wrapping OAuthProviderCard.
 */
export function ChatGptAccountCard() {
  return <OAuthProviderCard providerId="chatgpt" />;
}
