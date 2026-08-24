import type { ModelMessage, SystemModelMessage } from "ai";
import type { ProviderId } from "@/modules/ai/config";

export type PreparedAgentPrompt = {
  system: SystemModelMessage[];
  messages: ModelMessage[];
};

export function prepareAgentPrompt(
  stableSystem: string,
  planInstructions: string | null,
  history: readonly ModelMessage[],
  provider: ProviderId,
): PreparedAgentPrompt {
  const system: SystemModelMessage[] = [
    { role: "system", content: stableSystem },
  ];
  if (planInstructions) {
    system.push({ role: "system", content: planInstructions });
  }
  const messages = history.slice();
  if (provider !== "anthropic") return { system, messages };

  system[0] = withAnthropicCacheMarker(system[0]);
  const lastIdx = messages.length - 1;
  if (lastIdx >= 0) {
    messages[lastIdx] = withAnthropicCacheMarker(messages[lastIdx]);
  }
  return { system, messages };
}

/**
 * Anthropic prompt-cache breakpoint.
 *
 * `ttl: "1h"` (not the 5-minute default) so a long agent run keeps its cache
 * warm across steps. The budget ladder goes 25 -> 50 -> 100 steps; a run that
 * crosses the 5-minute mark would otherwise drop its cache and pay full price
 * on the steps after the expiry, which is exactly the "why is it slow on step
 * 60" the run log exists to answer.
 */
const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

function withAnthropicCacheMarker<T extends ModelMessage>(message: T): T {
  return {
    ...message,
    providerOptions: {
      ...(message.providerOptions ?? {}),
      anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL },
    },
  };
}
