import type { ProviderId } from "@/modules/ai/config";
import {
  AiBrain01Icon,
  AiBrain02Icon,
  AiCloud01Icon,
  AppleIcon,
  ChatGptIcon,
  ClaudeIcon,
  ComputerIcon,
  CpuIcon,
  DeepseekIcon,
  FlashIcon,
  GlobeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
  MistralIcon,
  PlugIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ICON_BY_PROVIDER = {
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  deepseek: DeepseekIcon,
  stepfun: AiBrain01Icon,
  qwen: AiCloud01Icon,
  zhipu: AiBrain02Icon,
  mistral: MistralIcon,
  openrouter: GlobeIcon,
  "openai-compatible": PlugIcon,
  lmstudio: ComputerIcon,
  mlx: AppleIcon,
  ollama: ServerStack01Icon,
  chatgpt: ChatGptIcon,
  "claude-oauth": ClaudeIcon,
  "xai-oauth": Grok02Icon,
  "github-copilot": ComputerIcon,
  antigravity: GoogleGeminiIcon,
  muse: AiBrain01Icon,
  moonshot: AiBrain02Icon,
  minimax: CpuIcon,
  together: GlobeIcon,
  fireworks: FlashIcon,
  deepinfra: ServerStack01Icon,
  siliconflow: FlashIcon,
  nebius: AiCloud01Icon,
  nvidia: CpuIcon,
  sambanova: FlashIcon,
  novita: AiCloud01Icon,
  hyperbolic: FlashIcon,
  chutes: ServerStack01Icon,
  perplexity: GlobeIcon,
  cohere: AiBrain01Icon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

type Props = {
  provider: ProviderId;
  size?: number;
  className?: string;
};

export function ProviderIcon({ provider, size = 14, className }: Props) {
  return (
    <HugeiconsIcon
      icon={ICON_BY_PROVIDER[provider]}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
