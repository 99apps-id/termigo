package provider

import "strings"

// Model is one entry in the model catalogue: a stable local id, the provider
// it belongs to, and the id sent on the wire when it differs.
type Model struct {
	ID          string
	Provider    string
	Label       string
	APIID       string
	Description string
	Tags        []string
}

// WireID is the id sent to the provider.
func (m Model) WireID() string {
	if m.APIID != "" {
		return m.APIID
	}
	return m.ID
}

var models = []Model{
	// OpenAI. Astra is the flagship, Sol the middle, Luna the fast tier.
	{ID: "gpt-6-astra", Provider: "openai", Label: "GPT-6 Astra", Description: "Flagship for the hardest end-to-end work.", Tags: []string{"reasoning", "tools", "vision", "coding"}},
	{ID: "gpt-6-sol", Provider: "openai", Label: "GPT-6 Sol", Description: "Balances intelligence and cost.", Tags: []string{"reasoning", "tools", "vision", "coding"}},
	{ID: "gpt-6-luna", Provider: "openai", Label: "GPT-6 Luna", Description: "Efficient tier for high-volume work.", Tags: []string{"fast", "tools", "coding"}},
	{ID: "gpt-5.6-terra", Provider: "openai", Label: "GPT-5.6 Terra", Description: "Previous balanced generation.", Tags: []string{"reasoning", "tools"}},
	{ID: "gpt-5.6-sol", Provider: "openai", Label: "GPT-5.6 Sol", Description: "Balanced previous generation.", Tags: []string{"reasoning", "tools"}},
	{ID: "gpt-5.6-luna", Provider: "openai", Label: "GPT-5.6 Luna", Description: "Efficient previous generation.", Tags: []string{"fast", "tools"}},
	{ID: "gpt-5.5", Provider: "openai", Label: "GPT-5.5", Description: "Previous frontier generation.", Tags: []string{"reasoning", "tools"}},
	{ID: "gpt-5.4", Provider: "openai", Label: "GPT-5.4", Description: "Long-context workhorse.", Tags: []string{"tools", "vision"}},
	{ID: "gpt-5.4-mini", Provider: "openai", Label: "GPT-5.4 mini", Description: "Fast and inexpensive.", Tags: []string{"fast", "tools"}},
	{ID: "gpt-5.3-codex", Provider: "openai", Label: "GPT-5.3 Codex", Description: "Tuned for agentic software engineering.", Tags: []string{"coding", "tools"}},
	{ID: "gpt-4.5", Provider: "openai", Label: "GPT-4.5", APIID: "gpt-4.5-preview", Description: "Frontier knowledge and coding model.", Tags: []string{"vision", "tools", "coding"}},
	// The models served through a ChatGPT login (Codex OAuth). The local id
	// is distinct because the catalogue keys by id alone; APIID is what goes
	// on the wire. The newest Codex generation first.
	{ID: "codex-gpt-6.1-sol", Provider: "openai-codex", Label: "GPT-6.1 Sol (ChatGPT)", APIID: "gpt-6.1-sol", Description: "Newest Sol tier through a ChatGPT login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "codex-gpt-6-astra", Provider: "openai-codex", Label: "GPT-6 Astra (ChatGPT)", APIID: "gpt-6-astra", Description: "Flagship through a ChatGPT login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "codex-gpt-6.1-terra", Provider: "openai-codex", Label: "GPT-6.1 Terra (ChatGPT)", APIID: "gpt-6.1-terra", Description: "Newest Terra tier through a ChatGPT login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "codex-gpt-6-luna", Provider: "openai-codex", Label: "GPT-6 Luna (ChatGPT)", APIID: "gpt-6-luna", Description: "Efficient through a ChatGPT login.", Tags: []string{"fast", "tools"}},

	// Anthropic: the current generation (Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5).
	{ID: "claude-fable-5-2", Provider: "anthropic", Label: "Claude Fable 5.2", Description: "Most capable Claude for the hardest long-horizon work.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-opus-5-5", Provider: "anthropic", Label: "Claude Opus 5.5", Description: "Long-running agentic coding and knowledge work.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-sonnet-5-5", Provider: "anthropic", Label: "Claude Sonnet 5.5", Description: "Frontier speed and intelligence for agentic coding.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-haiku-5-5", Provider: "anthropic", Label: "Claude Haiku 5.5", Description: "Fastest current Claude.", Tags: []string{"fast", "tools"}},
	// The Claude models served through a Claude login (OAuth).
	{ID: "claude-oauth-fable-5-2", Provider: "claude-oauth", Label: "Claude Fable 5.2 (OAuth)", APIID: "claude-fable-5-2", Description: "Most capable Claude through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-opus-5-5", Provider: "claude-oauth", Label: "Claude Opus 5.5 (OAuth)", APIID: "claude-opus-5-5", Description: "Flagship reasoning and coding through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-sonnet-5-5", Provider: "claude-oauth", Label: "Claude Sonnet 5.5 (OAuth)", APIID: "claude-sonnet-5-5", Description: "Frontier speed and intelligence through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-haiku-5-5", Provider: "claude-oauth", Label: "Claude Haiku 5.5 (OAuth)", APIID: "claude-haiku-5-5", Description: "Fastest current Claude through a Claude login.", Tags: []string{"fast", "tools"}},

	// GitHub Copilot models served through a GitHub login (OAuth).
	// GitHub Copilot models served through a GitHub login. The wire ids are
	// the account's live catalogue at api.githubcopilot.com/models; a Copilot
	// account only serves the entries its policy enables, so models that a
	// given account has disabled are not offered here.
	{ID: "copilot-gpt-6.1-sol", Provider: "github-copilot", Label: "GPT-6.1 Sol (Copilot)", APIID: "gpt-6.1-sol", Description: "Newest Sol tier through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-claude-sonnet-5-5", Provider: "github-copilot", Label: "Claude Sonnet 5.5 (Copilot)", APIID: "claude-sonnet-5.5", Description: "Frontier Claude through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-gemini-3.8-flash", Provider: "github-copilot", Label: "Gemini 3.8 Flash (Copilot)", APIID: "gemini-3.8-flash", Description: "Fast Gemini through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-gpt-6.1-terra", Provider: "github-copilot", Label: "GPT-6.1 Terra (Copilot)", APIID: "gpt-6.1-terra", Description: "Newest Terra tier through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-gpt-6-astra", Provider: "github-copilot", Label: "GPT-6 Astra (Copilot)", APIID: "gpt-6-astra", Description: "GPT-6 flagship through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-gpt-6-luna", Provider: "github-copilot", Label: "GPT-6 Luna (Copilot)", APIID: "gpt-6-luna", Description: "Efficient GPT through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-claude-opus-5-5", Provider: "github-copilot", Label: "Claude Opus 5.5 (Copilot)", APIID: "claude-opus-5.5", Description: "Flagship Claude through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-claude-haiku-5-5", Provider: "github-copilot", Label: "Claude Haiku 5.5 (Copilot)", APIID: "claude-haiku-5.5", Description: "Fastest current Claude through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-gemini-4-argon", Provider: "github-copilot", Label: "Gemini 4 Argon (Copilot)", APIID: "gemini-4-argon", Description: "Gemini 4 flagship through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-grok-4.7", Provider: "github-copilot", Label: "Grok 4.7 (Copilot)", APIID: "grok-4.7", Description: "xAI Grok through GitHub Copilot.", Tags: []string{"reasoning", "tools"}},
	{ID: "copilot-kimi-k3", Provider: "github-copilot", Label: "Kimi K3 (Copilot)", APIID: "kimi-k3", Description: "Moonshot Kimi through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-mai-code-1-flash", Provider: "github-copilot", Label: "MAI-Code-1.1-Flash (Copilot)", APIID: "mai-code-1.1-flash", Description: "Fast coding model through GitHub Copilot.", Tags: []string{"coding", "fast"}},
	// Google Antigravity serves Gemini and Claude models through its Cloud
	// Code backend under an Antigravity login.
	// The Cloud Code backend keys models by an upstream id that differs
	// from the catalogue id. The tier lives in the model name itself
	// (gemini-3.8-flash-medium); 9router's "(medium)" preset is stripped
	// before the request and sent as thinkingConfig, so it must not be part
	// of the id. A wrong id returns 404 "check the model id and base URL".
	{ID: "antigravity-gemini-4-hydrogen", Provider: "antigravity", Label: "Gemini 4 Hydrogen (Antigravity)", APIID: "gemini-4-hydrogen-high", Description: "Fast agentic Gemini 4 on every Antigravity plan.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "antigravity-gemini-4-argon", Provider: "antigravity", Label: "Gemini 4 Argon (Antigravity)", APIID: "gemini-4-argon-medium", Description: "Gemini 4 flagship for Pro, Ultra and Enterprise plans.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "antigravity-gemini-4-carbon", Provider: "antigravity", Label: "Gemini 4 Carbon (Antigravity)", APIID: "gemini-4-carbon-medium", Description: "Top Gemini 4 tier; Google AI Ultra and Enterprise only.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "antigravity-gemini-3.8-flash", Provider: "antigravity", Label: "Gemini 3.8 Flash (Antigravity)", APIID: "gemini-3.8-flash-medium", Description: "Fast Gemini through an Antigravity login.", Tags: []string{"fast", "tools", "coding"}},
	{ID: "antigravity-gemini-3.8-flash-high", Provider: "antigravity", Label: "Gemini 3.8 Flash High (Antigravity)", APIID: "gemini-3.8-flash-high", Description: "Deep thinking Gemini Flash through an Antigravity login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "antigravity-claude-opus-5-5", Provider: "antigravity", Label: "Claude Opus 5.5 (Antigravity)", APIID: "claude-opus-5-5-medium", Description: "Flagship Claude through an Antigravity login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "antigravity-claude-sonnet-5-5", Provider: "antigravity", Label: "Claude Sonnet 5.5 (Antigravity)", APIID: "claude-sonnet-5-5-medium", Description: "Fast Claude through an Antigravity login.", Tags: []string{"reasoning", "tools", "coding"}},
	// Meta Muse Code. The device grant mints an account key; the model id is
	// what api.meta.ai serves it under.
	{ID: "muse-spark-1.3", Provider: "muse", Label: "Muse Spark 1.3", APIID: "muse-spark-1.3", Description: "Meta's coding model through a Muse Code login.", Tags: []string{"coding", "tools"}},

	// Google. The Flash line ships far more often than the Pro one.
	{ID: "gemini-4-argon", Provider: "google", Label: "Gemini 4 Argon", Description: "Next-generation flagship reasoning and agentic model.", Tags: []string{"reasoning", "tools", "vision", "coding"}},
	{ID: "gemini-3.1-pro-preview", Provider: "google", Label: "Gemini 3.1 Pro", Description: "Frontier reasoning with a large window.", Tags: []string{"reasoning", "tools", "vision"}},
	{ID: "gemini-3.8-flash", Provider: "google", Label: "Gemini 3.8 Flash", Description: "Newest Flash: software engineering and agentic tasks.", Tags: []string{"tools", "vision", "fast"}},
	{ID: "gemini-3.7-flash", Provider: "google", Label: "Gemini 3.7 Flash", Description: "Fast agentic workflows and coding.", Tags: []string{"tools", "fast"}},
	{ID: "gemini-3.5-flash", Provider: "google", Label: "Gemini 3.5 Flash", Description: "Near-Pro coding at Flash cost.", Tags: []string{"tools", "fast"}},
	{ID: "gemini-3.5-flash-lite", Provider: "google", Label: "Gemini 3.5 Flash Lite", Description: "Subagents and focused tasks.", Tags: []string{"fast"}},

	// xAI. Build is the coding-tuned line.
	{ID: "grok-4.7", Provider: "xai", Label: "Grok 4.7", Description: "Flagship for coding and agentic tasks.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "grok-4.6", Provider: "xai", Label: "Grok 4.6", Description: "Previous flagship.", Tags: []string{"reasoning", "tools"}},
	{ID: "grok-4.5", Provider: "xai", Label: "Grok 4.5", Description: "Frontier coding and STEM.", Tags: []string{"reasoning", "tools"}},
	{ID: "grok-build-0.1", Provider: "xai", Label: "Grok Build 0.1", Description: "Fast model tuned for agentic coding.", Tags: []string{"coding", "fast"}},
	// The Grok models served through a SuperGrok login (OAuth).
	{ID: "grok-4.7-oauth", Provider: "xai-oauth", Label: "Grok 4.7 (OAuth)", APIID: "grok-4.7", Description: "Flagship coding model through a Grok login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "grok-4.5-oauth", Provider: "xai-oauth", Label: "Grok 4.5 (OAuth)", APIID: "grok-4.5", Description: "Frontier coding and STEM through a Grok login.", Tags: []string{"reasoning", "tools"}},
	{ID: "grok-build-0.1-oauth", Provider: "xai-oauth", Label: "Grok Build 0.1 (OAuth)", APIID: "grok-build-0.1", Description: "Fast agentic coding through a Grok login.", Tags: []string{"coding", "fast"}},

	// DeepSeek. Pro is the large MoE, Flash the cheap one.
	{ID: "deepseek-v4-pro", Provider: "deepseek", Label: "DeepSeek V4 Pro", Description: "Large MoE for advanced reasoning and coding.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "deepseek-v4.1-flash", Provider: "deepseek", Label: "DeepSeek V4.1 Flash", APIID: "deepseek-flash", Description: "Sparse MoE, cheap and fast.", Tags: []string{"fast", "tools", "coding"}},
	{ID: "deepseek-v4-flash", Provider: "deepseek", Label: "DeepSeek V4 Flash", Description: "Cheapest DeepSeek tier.", Tags: []string{"fast", "coding"}},

	// StepFun. Three point seven Flash is the current efficient model.
	{ID: "step-3.7-flash", Provider: "stepfun", Label: "Step 3.7 Flash", Description: "Multimodal MoE for agentic coding.", Tags: []string{"tools", "vision", "coding"}},
	{ID: "step-3.5-flash", Provider: "stepfun", Label: "Step 3.5 Flash", Description: "Previous efficient generation.", Tags: []string{"fast", "tools"}},

	// StepFun Plan. The same models through the plan endpoint, so the plan
	// is a provider of its own rather than a hand-configured custom
	// endpoint. The host prefix keeps the id unique.
	{ID: "stepfun-plan/step-3.7-flash", Provider: "stepfun-plan", Label: "Step 3.7 Flash (Plan)", APIID: "step-3.7-flash", Description: "Step 3.7 Flash on the StepFun plan endpoint.", Tags: []string{"tools", "coding"}},
	{ID: "stepfun-plan/step-3.5-flash", Provider: "stepfun-plan", Label: "Step 3.5 Flash (Plan)", APIID: "step-3.5-flash", Description: "Step 3.5 Flash on the StepFun plan endpoint.", Tags: []string{"fast", "tools"}},

	// Moonshot. K3 is the open-weight flagship.
	{ID: "kimi-k3", Provider: "moonshot", Label: "Kimi K3", Description: "Open-weight multimodal reasoning at scale.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "kimi-k2.7-code", Provider: "moonshot", Label: "Kimi K2.7 Code", Description: "Coding-focused, long contexts.", Tags: []string{"coding", "tools"}},
	{ID: "kimi-k2.6", Provider: "moonshot", Label: "Kimi K2.6", Description: "Long-horizon coding and UI generation.", Tags: []string{"coding", "tools"}},

	// MiniMax. M3 is multimodal with a 1M window.
	{ID: "minimax-m3", Provider: "minimax", Label: "MiniMax M3", Description: "Multimodal, long-horizon agentic work.", Tags: []string{"tools", "vision", "coding"}},
	{ID: "minimax-m2.7", Provider: "minimax", Label: "MiniMax M2.7", Description: "Compact agentic model.", Tags: []string{"tools", "fast"}},

	// Zhipu. Flash keeps a 1.3M window at a low price.
	{ID: "glm-5.3", Provider: "zhipu", Label: "GLM 5.3", Description: "Long-horizon software engineering.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "glm-5.3-flash", Provider: "zhipu", Label: "GLM 5.3 Flash", Description: "Efficient coding with a very large window.", Tags: []string{"fast", "tools", "coding"}},
	{ID: "glm-4.7", Provider: "zhipu", Label: "GLM 4.7", Description: "Previous generation, cheap.", Tags: []string{"tools"}},

	// Alibaba Qwen.
	{ID: "qwen3.8-max", Provider: "qwen", Label: "Qwen3.8 Max", Description: "Flagship MoE, text image and video.", Tags: []string{"reasoning", "tools", "vision"}},
	{ID: "qwen3.8-27b", Provider: "qwen", Label: "Qwen3.8 27B", Description: "Open-weight dense vision-language model.", Tags: []string{"tools", "vision"}},
	{ID: "qwen3.7-max", Provider: "qwen", Label: "Qwen3.7 Max", Description: "Previous flagship.", Tags: []string{"tools"}},

	// Qwen Cloud Token Plan. The plan bundles Qwen, DeepSeek and GLM
	// models behind one endpoint, so each entry carries the host prefix and
	// the wire id the plan expects.
	{ID: "qwen-token-plan/qwen3.8-max", Provider: "qwen-token-plan", Label: "Qwen3.8 Max (Token Plan)", APIID: "qwen3.8-max", Description: "Qwen3.8 Max on the Qwen Cloud token plan.", Tags: []string{"reasoning", "tools", "vision"}},
	{ID: "qwen-token-plan/qwen3.8-27b", Provider: "qwen-token-plan", Label: "Qwen3.8 27B (Token Plan)", APIID: "qwen3.8-27b", Description: "Qwen3.8 27B on the Qwen Cloud token plan.", Tags: []string{"tools", "vision"}},
	{ID: "qwen-token-plan/qwen3.7-max", Provider: "qwen-token-plan", Label: "Qwen3.7 Max (Token Plan)", APIID: "qwen3.7-max", Description: "Qwen3.7 Max on the Qwen Cloud token plan.", Tags: []string{"tools"}},
	{ID: "qwen-token-plan/qwen3.8-flash", Provider: "qwen-token-plan", Label: "Qwen3.8 Flash (Token Plan)", APIID: "qwen3.8-flash", Description: "Fast Qwen3.8 tier on the Qwen Cloud token plan.", Tags: []string{"fast", "tools", "coding"}},
	{ID: "qwen-token-plan/qwen3.6-flash", Provider: "qwen-token-plan", Label: "Qwen3.6 Flash (Token Plan)", APIID: "qwen3.6-flash", Description: "Efficient Qwen3.6 tier on the Qwen Cloud token plan.", Tags: []string{"fast", "tools"}},
	{ID: "qwen-token-plan/deepseek-v4.1-flash", Provider: "qwen-token-plan", Label: "DeepSeek V4.1 Flash (Token Plan)", APIID: "deepseek-v4.1-flash", Description: "Sparse MoE on the Qwen Cloud token plan.", Tags: []string{"fast", "tools", "coding"}},
	{ID: "qwen-token-plan/deepseek-v4-pro-0813", Provider: "qwen-token-plan", Label: "DeepSeek V4 Pro 0813 (Token Plan)", APIID: "deepseek-v4-pro-0813", Description: "Pinned DeepSeek V4 Pro build on the Qwen Cloud token plan.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "qwen-token-plan/deepseek-v4-pro", Provider: "qwen-token-plan", Label: "DeepSeek V4 Pro (Token Plan)", APIID: "deepseek-v4-pro", Description: "DeepSeek V4 Pro on the Qwen Cloud token plan.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "qwen-token-plan/deepseek-v4-flash-0731", Provider: "qwen-token-plan", Label: "DeepSeek V4 Flash 0731 (Token Plan)", APIID: "deepseek-v4-flash-0731", Description: "Pinned DeepSeek V4 Flash build on the Qwen Cloud token plan.", Tags: []string{"fast", "coding"}},
	{ID: "qwen-token-plan/glm-5.3", Provider: "qwen-token-plan", Label: "GLM 5.3 (Token Plan)", APIID: "glm-5.3", Description: "Zhipu GLM 5.3 on the Qwen Cloud token plan.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "qwen-token-plan/glm-5.2", Provider: "qwen-token-plan", Label: "GLM 5.2 (Token Plan)", APIID: "glm-5.2", Description: "Zhipu GLM 5.2 on the Qwen Cloud token plan.", Tags: []string{"tools", "coding"}},

	// Mistral. Large 3 and Devstral are the ones that matter here.
	{ID: "mistral-large-2512", Provider: "mistral", Label: "Mistral Large 3", Description: "Most capable Mistral.", Tags: []string{"tools", "coding"}},
	{ID: "devstral-2512", Provider: "mistral", Label: "Devstral 2", Description: "Open-weight agentic coding model.", Tags: []string{"coding", "tools"}},
	{ID: "mistral-medium-3-5", Provider: "mistral", Label: "Mistral Medium 3.5", Description: "Balanced agentic workhorse.", Tags: []string{"tools", "fast"}},
	{ID: "codestral-2508", Provider: "mistral", Label: "Codestral 2508", Description: "Low-latency code completion and repair.", Tags: []string{"coding", "fast"}},

	// Baidu.
	{ID: "ernie-4.5-300b-a47b", Provider: "baidu", Label: "ERNIE 4.5 300B", Description: "Baidu MoE flagship.", Tags: []string{"tools"}},

	// Volcengine.
	{ID: "doubao-seed-2-1-pro", Provider: "volcengine", Label: "Doubao Seed 2.1 Pro", Description: "ByteDance flagship on Volcengine.", Tags: []string{"tools", "vision"}},
	{ID: "doubao-seed-2-1-turbo", Provider: "volcengine", Label: "Doubao Seed 2.1 Turbo", Description: "Faster Seed tier.", Tags: []string{"fast", "tools"}},

	// Fast inference hosts: open weights, served quickly.
	{ID: "openai/gpt-oss-120b", Provider: "groq", Label: "GPT-OSS 120B (Groq)", Description: "Open-weight flagship at high speed.", Tags: []string{"reasoning", "tools", "fast"}},
	{ID: "openai/gpt-oss-20b", Provider: "groq", Label: "GPT-OSS 20B (Groq)", Description: "Small open-weight model.", Tags: []string{"fast"}},
	{ID: "llama-3.3-70b-versatile", Provider: "groq", Label: "Llama 3.3 70B (Groq)", Description: "Open model at very high speed.", Tags: []string{"fast", "tools"}},
	{ID: "qwen/qwen3.8-27b", Provider: "groq", Label: "Qwen3.8 27B (Groq)", Description: "Open vision-language model on Groq.", Tags: []string{"tools", "fast"}},

	{ID: "gpt-oss-120b", Provider: "cerebras", Label: "GPT-OSS 120B (Cerebras)", Description: "Open weights at wafer scale.", Tags: []string{"reasoning", "tools", "fast"}},
	{ID: "qwen-3.8-27b", Provider: "cerebras", Label: "Qwen3.8 27B (Cerebras)", Description: "Open vision-language model, very fast.", Tags: []string{"tools", "fast"}},

	// Aggregators and research endpoints.
	{ID: "openrouter/auto", Provider: "openrouter", Label: "OpenRouter Auto", Description: "Routes to the best model for the prompt.", Tags: []string{"tools"}},
	{ID: "anthropic/claude-opus-5.5", Provider: "openrouter", Label: "Claude Opus 5.5 (OR)", Description: "Anthropic via OpenRouter.", Tags: []string{"reasoning", "tools"}},
	{ID: "openai/gpt-6-astra", Provider: "openrouter", Label: "GPT-6 Astra (OR)", Description: "OpenAI via OpenRouter.", Tags: []string{"reasoning", "tools"}},
	{ID: "moonshotai/kimi-k3", Provider: "openrouter", Label: "Kimi K3 (OR)", Description: "Open weights via OpenRouter.", Tags: []string{"reasoning", "tools"}},
	{ID: "z-ai/glm-5.3", Provider: "openrouter", Label: "GLM 5.3 (OR)", Description: "Zhipu via OpenRouter.", Tags: []string{"tools"}},
	{ID: "qwen/qwen3.8-max", Provider: "openrouter", Label: "Qwen3.8 Max (OR)", Description: "Alibaba via OpenRouter.", Tags: []string{"tools", "vision"}},
	{ID: "deepseek/deepseek-v4-pro", Provider: "openrouter", Label: "DeepSeek V4 Pro (OR)", Description: "DeepSeek via OpenRouter.", Tags: []string{"reasoning"}},

	// Open weights on a third-party host.
	//
	// The stable id is prefixed with the host because several hosts serve
	// the same model: two catalogue entries sharing one id would make
	// ModelByID ambiguous, and the picker would silently switch provider.
	// APIID carries the name that host actually expects on the wire.
	{ID: "together/kimi-k3", Provider: "together", Label: "Kimi K3 (Together)", APIID: "moonshotai/Kimi-K3", Description: "Kimi K3 on Together AI.", Tags: []string{"reasoning", "tools"}},
	{ID: "together/qwen3.8-27b", Provider: "together", Label: "Qwen3.8 27B (Together)", APIID: "Qwen/Qwen3.8-27B", Description: "Open vision-language model.", Tags: []string{"tools"}},
	{ID: "deepinfra/kimi-k3", Provider: "deepinfra", Label: "Kimi K3 (DeepInfra)", APIID: "moonshotai/Kimi-K3", Description: "Kimi K3 on DeepInfra.", Tags: []string{"reasoning", "tools"}},
	{ID: "deepinfra/qwen3.8-27b", Provider: "deepinfra", Label: "Qwen3.8 27B (DeepInfra)", APIID: "Qwen/Qwen3.8-27B", Description: "Open vision-language model.", Tags: []string{"tools"}},
	{ID: "fireworks/deepseek-v4-pro", Provider: "fireworks", Label: "DeepSeek V4 Pro (Fireworks)", APIID: "accounts/fireworks/models/deepseek-v4-pro", Description: "DeepSeek hosted by Fireworks.", Tags: []string{"reasoning", "tools"}},
	{ID: "fireworks/kimi-k3", Provider: "fireworks", Label: "Kimi K3 (Fireworks)", APIID: "accounts/fireworks/models/kimi-k3", Description: "Kimi hosted by Fireworks.", Tags: []string{"reasoning", "tools"}},
	{ID: "siliconflow/deepseek-v4-pro", Provider: "siliconflow", Label: "DeepSeek V4 Pro (SiliconFlow)", APIID: "deepseek-ai/DeepSeek-V4-Pro", Description: "DeepSeek on SiliconFlow.", Tags: []string{"reasoning"}},
	{ID: "novita/deepseek-v4-pro", Provider: "novita", Label: "DeepSeek V4 Pro (Novita)", APIID: "deepseek/deepseek-v4-pro", Description: "DeepSeek on Novita.", Tags: []string{"reasoning"}},
	{ID: "nvidia/kimi-k3", Provider: "nvidia", Label: "Kimi K3 (NVIDIA NIM)", APIID: "moonshotai/kimi-k3", Description: "Kimi K3 on NVIDIA NIM.", Tags: []string{"reasoning", "tools"}},
	{ID: "nebius/kimi-k3", Provider: "nebius", Label: "Kimi K3 (Nebius)", APIID: "moonshotai/Kimi-K3", Description: "Kimi K3 on Nebius.", Tags: []string{"reasoning", "tools"}},
	{ID: "sambanova/minimax-m2.7", Provider: "sambanova", Label: "MiniMax M2.7 (SambaNova)", APIID: "MiniMax-M2.7", Description: "Agentic model on SambaNova.", Tags: []string{"tools", "fast"}},
	{ID: "hyperbolic/qwen3.8-27b", Provider: "hyperbolic", Label: "Qwen3.8 27B (Hyperbolic)", APIID: "Qwen/Qwen3.8-27B", Description: "Open vision-language model.", Tags: []string{"tools"}},
	{ID: "huggingface/glm-5.3", Provider: "huggingface", Label: "GLM 5.3 (HF Router)", APIID: "zai-org/GLM-5.3", Description: "Zhipu via the Hugging Face router.", Tags: []string{"tools"}},
	{ID: "vercel/minimax-m3", Provider: "vercel", Label: "MiniMax M3 (AI Gateway)", APIID: "minimax/minimax-m3", Description: "One key across many vendors.", Tags: []string{"tools"}},
	{ID: "github/gpt-6-astra", Provider: "github", Label: "GPT-6 Astra (GitHub)", APIID: "openai/gpt-6-astra", Description: "Frontier models billed to a GitHub account.", Tags: []string{"reasoning", "tools"}},

	{ID: "sonar-pro", Provider: "perplexity", Label: "Sonar Pro", Description: "Search-backed answers with citations.", Tags: []string{"search"}},
	{ID: "sonar-deep-research", Provider: "perplexity", Label: "Sonar Deep Research", Description: "Multi-step retrieval and synthesis.", Tags: []string{"search", "reasoning"}},

	{ID: "command-a-plus-05-2026", Provider: "cohere", Label: "Command A+", Description: "Enterprise agentic workflows.", Tags: []string{"tools"}},

	// Local servers. These ids are what the servers themselves use, so they
	// resolve without the operator adding anything to the config. The list
	// covers the tags people actually pull, which is why a couple of older
	// ones are kept: an operator who already has the model should find it.
	{ID: "qwen3.8:27b", Provider: "ollama", Label: "Qwen3.8 27B", Description: "Local vision-language model.", Tags: []string{"local", "tools"}},
	{ID: "qwen3-coder:30b", Provider: "ollama", Label: "Qwen3 Coder 30B", Description: "Local coding model.", Tags: []string{"local", "coding"}},
	{ID: "gpt-oss:20b", Provider: "ollama", Label: "GPT-OSS 20B", Description: "Local open-weight model.", Tags: []string{"local", "tools"}},
	{ID: "glm-4.7-flash:latest", Provider: "ollama", Label: "GLM 4.7 Flash", Description: "Local agentic coding model.", Tags: []string{"local", "coding"}},
	{ID: "deepseek-v4-flash:latest", Provider: "ollama", Label: "DeepSeek V4 Flash", Description: "Local DeepSeek.", Tags: []string{"local", "coding"}},
	{ID: "qwen2.5-coder:latest", Provider: "ollama", Label: "Qwen2.5 Coder", Description: "Older local coding model, still widely pulled.", Tags: []string{"local", "coding"}},
	{ID: "llama3.2:latest", Provider: "ollama", Label: "Llama 3.2", Description: "Older local general model.", Tags: []string{"local"}},

	{ID: "qwen3.8-27b-lmstudio", Provider: "lmstudio", Label: "Qwen3.8 27B (LM Studio)", APIID: "qwen3.8-27b", Description: "Loaded in LM Studio.", Tags: []string{"local", "tools"}},
	{ID: "qwen3.8-27b-mlx", Provider: "mlx", Label: "Qwen3.8 27B (MLX)", APIID: "qwen3.8-27b", Description: "Loaded in MLX on Apple silicon.", Tags: []string{"local", "tools"}},
}

// Models lists the catalogue in display order.
func Models() []Model { return models }

// ModelsFor returns one provider's models in catalogue order.
func ModelsFor(providerID string) []Model {
	out := make([]Model, 0, 8)
	for _, model := range models {
		if model.Provider == providerID {
			out = append(out, model)
		}
	}
	return out
}

// ModelByID finds a model by its stable id.
func ModelByID(id string) (Model, bool) {
	for _, model := range models {
		if model.ID == id {
			return model, true
		}
	}
	return Model{}, false
}

// ModelFromQuery resolves free text to a model: an exact id, then a unique
// case-insensitive substring of the id or label, then "provider:id".
func ModelFromQuery(query string) (Model, bool) {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return Model{}, false
	}
	for _, model := range models {
		if model.ID == needle || strings.ToLower(model.WireID()) == needle {
			return model, true
		}
	}
	if index := strings.Index(needle, ":"); index > 0 {
		if _, ok := ByID(needle[:index]); ok {
			return Model{ID: query, Provider: needle[:index], Label: query, APIID: query}, true
		}
	}
	var match *Model
	for i := range models {
		haystack := strings.ToLower(models[i].ID + " " + models[i].Label + " " + models[i].Provider)
		if strings.Contains(haystack, needle) {
			if match != nil {
				return Model{}, false
			}
			match = &models[i]
		}
	}
	if match != nil {
		return *match, true
	}
	return Model{}, false
}
