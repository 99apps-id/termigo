package provider

// Minimal provider registry for the Termigo CLI: enough to build a client for
// an OpenAI-compatible endpoint (and to resolve a key or OAuth token). The
// specialised Codex, Antigravity and Copilot clients are not wired yet.

// Kind is the wire protocol a provider speaks.
type Kind string

const (
	KindOpenAI      Kind = "openai"
	KindAnthropic   Kind = "anthropic"
	KindGoogle      Kind = "google"
	KindAntigravity Kind = "antigravity"
	KindCopilot     Kind = "copilot"
)

// Provider describes one BYOK provider.
type Provider struct {
	ID             string
	Label          string
	Kind           Kind
	DefaultBaseURL string
	NeedsKey       bool
	OAuth          bool
	EnvKeys        []string
}

var providers = []Provider{
	// Frontier vendors, each with its own wire protocol.
	{ID: "openai", Label: "OpenAI", Kind: KindOpenAI, DefaultBaseURL: "https://api.openai.com/v1", NeedsKey: true, EnvKeys: []string{"OPENAI_API_KEY"}},
	{ID: "anthropic", Label: "Anthropic", Kind: KindAnthropic, DefaultBaseURL: "https://api.anthropic.com", NeedsKey: true, EnvKeys: []string{"ANTHROPIC_API_KEY"}},
	{ID: "claude-oauth", Label: "Claude (OAuth)", Kind: KindAnthropic, DefaultBaseURL: "https://api.anthropic.com", NeedsKey: true, OAuth: true},
	{ID: "antigravity", Label: "Google Antigravity", Kind: KindAntigravity, DefaultBaseURL: "https://daily-cloudcode-pa.googleapis.com", NeedsKey: true, OAuth: true},
	{ID: "google", Label: "Google Gemini", Kind: KindGoogle, DefaultBaseURL: "https://generativelanguage.googleapis.com", NeedsKey: true, EnvKeys: []string{"GEMINI_API_KEY", "GOOGLE_API_KEY"}},
	{ID: "xai", Label: "xAI Grok", Kind: KindOpenAI, DefaultBaseURL: "https://api.x.ai/v1", NeedsKey: true, EnvKeys: []string{"XAI_API_KEY"}},
	{ID: "xai-oauth", Label: "xAI Grok (OAuth)", Kind: KindOpenAI, DefaultBaseURL: "https://api.x.ai/v1", NeedsKey: true, OAuth: true},
	{ID: "openai-codex", Label: "OpenAI Codex (ChatGPT)", Kind: KindOpenAI, DefaultBaseURL: "https://chatgpt.com/backend-api/codex", NeedsKey: true, OAuth: true},
	{ID: "github-copilot", Label: "GitHub Copilot", Kind: KindCopilot, DefaultBaseURL: "https://api.githubcopilot.com", NeedsKey: true, OAuth: true},

	// Vendors that matter most for agentic coding, cheapest strong models
	// first so the wizard's default order is also a sensible one.
	{ID: "deepseek", Label: "DeepSeek", Kind: KindOpenAI, DefaultBaseURL: "https://api.deepseek.com/v1", NeedsKey: true, EnvKeys: []string{"DEEPSEEK_API_KEY"}},
	{ID: "stepfun", Label: "StepFun", Kind: KindOpenAI, DefaultBaseURL: "https://api.stepfun.com/v1", NeedsKey: true, EnvKeys: []string{"STEPFUN_API_KEY", "STEPFUN_CN_API_KEY"}},
	{ID: "stepfun-plan", Label: "StepFun Plan", Kind: KindOpenAI, DefaultBaseURL: "https://api.stepfun.ai/step_plan/v1", NeedsKey: true, EnvKeys: []string{"STEPFUN_PLAN_API_KEY"}},
	{ID: "moonshot", Label: "Moonshot Kimi", Kind: KindOpenAI, DefaultBaseURL: "https://api.moonshot.cn/v1", NeedsKey: true, EnvKeys: []string{"MOONSHOT_API_KEY", "KIMI_API_KEY"}},
	{ID: "minimax", Label: "MiniMax", Kind: KindOpenAI, DefaultBaseURL: "https://api.minimax.io/v1", NeedsKey: true, EnvKeys: []string{"MINIMAX_API_KEY"}},
	{ID: "zhipu", Label: "Zhipu GLM", Kind: KindOpenAI, DefaultBaseURL: "https://open.bigmodel.cn/api/paas/v4", NeedsKey: true, EnvKeys: []string{"ZHIPU_API_KEY", "GLM_API_KEY"}},
	{ID: "qwen", Label: "Alibaba Qwen", Kind: KindOpenAI, DefaultBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", NeedsKey: true, EnvKeys: []string{"DASHSCOPE_API_KEY", "QWEN_API_KEY"}},
	{ID: "qwen-token-plan", Label: "Qwen Cloud Token Plan", Kind: KindOpenAI, DefaultBaseURL: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1", NeedsKey: true, EnvKeys: []string{"QWEN_TOKEN_PLAN_API_KEY"}},
	{ID: "mistral", Label: "Mistral", Kind: KindOpenAI, DefaultBaseURL: "https://api.mistral.ai/v1", NeedsKey: true, EnvKeys: []string{"MISTRAL_API_KEY"}},
	{ID: "baidu", Label: "Baidu Qianfan", Kind: KindOpenAI, DefaultBaseURL: "https://qianfan.baidubce.com/v2", NeedsKey: true, EnvKeys: []string{"QIANFAN_API_KEY", "BAIDU_API_KEY"}},
	{ID: "volcengine", Label: "Volcengine Ark (Doubao)", Kind: KindOpenAI, DefaultBaseURL: "https://ark.cn-beijing.volces.com/api/v3", NeedsKey: true, EnvKeys: []string{"ARK_API_KEY", "VOLCENGINE_API_KEY"}},
	{ID: "iflow", Label: "iFlow", Kind: KindOpenAI, DefaultBaseURL: "https://apis.iflow.cn/v1", NeedsKey: true, EnvKeys: []string{"IFLOW_API_KEY"}},

	// Fast inference hosts: the same open weights, served quickly.
	{ID: "groq", Label: "Groq", Kind: KindOpenAI, DefaultBaseURL: "https://api.groq.com/openai/v1", NeedsKey: true, EnvKeys: []string{"GROQ_API_KEY"}},
	{ID: "cerebras", Label: "Cerebras", Kind: KindOpenAI, DefaultBaseURL: "https://api.cerebras.ai/v1", NeedsKey: true, EnvKeys: []string{"CEREBRAS_API_KEY"}},
	{ID: "sambanova", Label: "SambaNova", Kind: KindOpenAI, DefaultBaseURL: "https://api.sambanova.ai/v1", NeedsKey: true, EnvKeys: []string{"SAMBANOVA_API_KEY"}},
	{ID: "fireworks", Label: "Fireworks", Kind: KindOpenAI, DefaultBaseURL: "https://api.fireworks.ai/inference/v1", NeedsKey: true, EnvKeys: []string{"FIREWORKS_API_KEY"}},
	{ID: "together", Label: "Together AI", Kind: KindOpenAI, DefaultBaseURL: "https://api.together.xyz/v1", NeedsKey: true, EnvKeys: []string{"TOGETHER_API_KEY"}},
	{ID: "deepinfra", Label: "DeepInfra", Kind: KindOpenAI, DefaultBaseURL: "https://api.deepinfra.com/v1/openai", NeedsKey: true, EnvKeys: []string{"DEEPINFRA_API_KEY"}},
	{ID: "novita", Label: "Novita AI", Kind: KindOpenAI, DefaultBaseURL: "https://api.novita.ai/v3/openai", NeedsKey: true, EnvKeys: []string{"NOVITA_API_KEY"}},
	{ID: "siliconflow", Label: "SiliconFlow", Kind: KindOpenAI, DefaultBaseURL: "https://api.siliconflow.com/v1", NeedsKey: true, EnvKeys: []string{"SILICONFLOW_API_KEY"}},
	{ID: "nebius", Label: "Nebius AI Studio", Kind: KindOpenAI, DefaultBaseURL: "https://api.studio.nebius.ai/v1", NeedsKey: true, EnvKeys: []string{"NEBIUS_API_KEY"}},
	{ID: "nvidia", Label: "NVIDIA NIM", Kind: KindOpenAI, DefaultBaseURL: "https://integrate.api.nvidia.com/v1", NeedsKey: true, EnvKeys: []string{"NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"}},
	{ID: "hyperbolic", Label: "Hyperbolic", Kind: KindOpenAI, DefaultBaseURL: "https://api.hyperbolic.xyz/v1", NeedsKey: true, EnvKeys: []string{"HYPERBOLIC_API_KEY"}},
	{ID: "lambda", Label: "Lambda Labs", Kind: KindOpenAI, DefaultBaseURL: "https://api.lambdalabs.com/v1", NeedsKey: true, EnvKeys: []string{"LAMBDA_API_KEY"}},
	{ID: "lepton", Label: "Lepton AI", Kind: KindOpenAI, DefaultBaseURL: "https://api.lepton.ai/v1", NeedsKey: true, EnvKeys: []string{"LEPTON_API_KEY"}},
	{ID: "chutes", Label: "Chutes", Kind: KindOpenAI, DefaultBaseURL: "https://llm.chutes.ai/v1", NeedsKey: true, EnvKeys: []string{"CHUTES_API_KEY"}},
	{ID: "huggingface", Label: "Hugging Face Router", Kind: KindOpenAI, DefaultBaseURL: "https://router.huggingface.co/v1", NeedsKey: true, EnvKeys: []string{"HF_TOKEN", "HUGGINGFACE_API_KEY"}},

	// Aggregators: one key, many vendors. Useful when a single budget has to
	// cover several model families.
	{ID: "openrouter", Label: "OpenRouter", Kind: KindOpenAI, DefaultBaseURL: "https://openrouter.ai/api/v1", NeedsKey: true, EnvKeys: []string{"OPENROUTER_API_KEY"}},
	{ID: "vercel", Label: "Vercel AI Gateway", Kind: KindOpenAI, DefaultBaseURL: "https://ai-gateway.vercel.sh/v1", NeedsKey: true, EnvKeys: []string{"AI_GATEWAY_API_KEY"}},
	{ID: "github", Label: "GitHub Models", Kind: KindOpenAI, DefaultBaseURL: "https://models.github.ai/inference", NeedsKey: true, EnvKeys: []string{"GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"}},
	{ID: "kilocode", Label: "Kilo Code", Kind: KindOpenAI, DefaultBaseURL: "https://api.kilo.ai/api/openrouter", NeedsKey: true, EnvKeys: []string{"KILOCODE_API_KEY"}},
	{ID: "venice", Label: "Venice AI", Kind: KindOpenAI, DefaultBaseURL: "https://api.venice.ai/api/v1", NeedsKey: true, EnvKeys: []string{"VENICE_API_KEY"}},
	{ID: "blackbox", Label: "Blackbox AI", Kind: KindOpenAI, DefaultBaseURL: "https://api.blackbox.ai/v1", NeedsKey: true, EnvKeys: []string{"BLACKBOX_API_KEY"}},

	// Search- and tool-centric endpoints. Useful for research rather than
	// for the edit loop, so they sit below the coding hosts.
	{ID: "perplexity", Label: "Perplexity", Kind: KindOpenAI, DefaultBaseURL: "https://api.perplexity.ai", NeedsKey: true, EnvKeys: []string{"PERPLEXITY_API_KEY"}},
	{ID: "cohere", Label: "Cohere", Kind: KindOpenAI, DefaultBaseURL: "https://api.cohere.ai/compatibility/v1", NeedsKey: true, EnvKeys: []string{"COHERE_API_KEY", "CO_API_KEY"}},
	{ID: "ai21", Label: "AI21 Labs", Kind: KindOpenAI, DefaultBaseURL: "https://api.ai21.com/studio/v1", NeedsKey: true, EnvKeys: []string{"AI21_API_KEY"}},

	// Endpoints whose URL contains an account or resource id, so there is no
	// usable default. Set them under `baseUrls` in the config.
	{ID: "cloudflare", Label: "Cloudflare Workers AI", Kind: KindOpenAI, DefaultBaseURL: "", NeedsKey: true, EnvKeys: []string{"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"}},
	{ID: "azure", Label: "Azure OpenAI", Kind: KindOpenAI, DefaultBaseURL: "", NeedsKey: true, EnvKeys: []string{"AZURE_OPENAI_API_KEY"}},
	{ID: "openai-compatible", Label: "OpenAI Compatible", Kind: KindOpenAI, DefaultBaseURL: "", EnvKeys: []string{"OPENAI_COMPATIBLE_API_KEY", "OPENAI_BASE_URL_KEY"}},

	// Local model servers. No key, no network: the model runs on the same
	// machine as the agent.
	{ID: "ollama", Label: "Ollama", Kind: KindOpenAI, DefaultBaseURL: "http://localhost:11434/v1"},
	{ID: "lmstudio", Label: "LM Studio", Kind: KindOpenAI, DefaultBaseURL: "http://localhost:1234/v1"},
	{ID: "mlx", Label: "MLX", Kind: KindOpenAI, DefaultBaseURL: "http://localhost:8080/v1"},
}

// Providers lists every provider in display order.
func Providers() []Provider { return providers }

// ByID resolves a provider id.
func ByID(id string) (Provider, bool) {
	for _, info := range providers {
		if info.ID == id {
			return info, true
		}
	}
	return Provider{}, false
}

// DefaultBaseURL returns the registry endpoint for a provider. The custom
// endpoint provider has no fixed host, so it falls back to the OpenAI base: a
// missing configuration then fails as a clear auth error instead of a
// missing-endpoint error.
func DefaultBaseURL(id string) string {
	info, ok := ByID(id)
	if !ok {
		return ""
	}
	if info.DefaultBaseURL != "" {
		return info.DefaultBaseURL
	}
	if id == "openai-compatible" {
		return "https://api.openai.com/v1"
	}
	return ""
}
