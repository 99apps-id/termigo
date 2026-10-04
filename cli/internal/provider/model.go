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
	// The models served through a ChatGPT login (Codex OAuth). The local id
	// is distinct because the catalogue keys by id alone; APIID is what goes
	// on the wire. The newest Codex generation first.
	{ID: "codex-gpt-6.1-sol", Provider: "openai-codex", Label: "GPT-6.1 Sol (ChatGPT)", APIID: "gpt-6.1-sol", Description: "Newest Sol tier through a ChatGPT login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "codex-gpt-6-astra", Provider: "openai-codex", Label: "GPT-6 Astra (ChatGPT)", APIID: "gpt-6-astra", Description: "Flagship through a ChatGPT login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "codex-gpt-6-sol", Provider: "openai-codex", Label: "GPT-6 Sol (ChatGPT)", APIID: "gpt-6-sol", Description: "Balanced through a ChatGPT login.", Tags: []string{"reasoning", "tools"}},
	{ID: "codex-gpt-6-luna", Provider: "openai-codex", Label: "GPT-6 Luna (ChatGPT)", APIID: "gpt-6-luna", Description: "Efficient through a ChatGPT login.", Tags: []string{"fast", "tools"}},
	{ID: "codex-gpt-5.6-terra", Provider: "openai-codex", Label: "GPT-5.6 Terra (ChatGPT)", APIID: "gpt-5.6-terra", Description: "Previous balanced generation through a ChatGPT login.", Tags: []string{"reasoning", "tools"}},
	{ID: "codex-gpt-5.6-sol", Provider: "openai-codex", Label: "GPT-5.6 Sol (ChatGPT)", APIID: "gpt-5.6-sol", Description: "Previous balanced generation through a ChatGPT login.", Tags: []string{"reasoning", "tools"}},
	{ID: "codex-gpt-5.6-luna", Provider: "openai-codex", Label: "GPT-5.6 Luna (ChatGPT)", APIID: "gpt-5.6-luna", Description: "Previous efficient generation through a ChatGPT login.", Tags: []string{"fast", "tools"}},
	{ID: "codex-gpt-5.5", Provider: "openai-codex", Label: "GPT-5.5 (ChatGPT)", APIID: "gpt-5.5", Description: "Latest frontier generation through a ChatGPT login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "codex-gpt-daybreak-blue-latest", Provider: "openai-codex", Label: "GPT Daybreak Blue (ChatGPT)", APIID: "gpt-daybreak-blue-latest", Description: "Live experimental codex model.", Tags: []string{"reasoning", "coding"}},
	{ID: "codex-gpt-reserve", Provider: "openai-codex", Label: "GPT Reserve (ChatGPT)", APIID: "gpt-reserve", Description: "Reserve capacity model through a ChatGPT login.", Tags: []string{"reasoning", "coding"}},
	{ID: "codex-auto-review", Provider: "openai-codex", Label: "Codex Auto Review (ChatGPT)", APIID: "codex-auto-review", Description: "Virtual auto-review model through a ChatGPT login.", Tags: []string{"coding"}},
	// gpt-5.4, gpt-5.4-mini and gpt-5.3-codex-spark are gone from
	// backend-api/codex/models for ChatGPT accounts and return HTTP 400
	// "model is not supported", so they are not offered (9router #4202).
	{ID: "codex-gpt-5.3-codex", Provider: "openai-codex", Label: "GPT-5.3 Codex", APIID: "gpt-5.3-codex", Description: "Agentic software engineering.", Tags: []string{"coding", "tools"}},
	{ID: "codex-gpt-5.2-codex", Provider: "openai-codex", Label: "GPT-5.2 Codex", APIID: "gpt-5.2-codex", Description: "Previous Codex generation.", Tags: []string{"coding", "tools"}},
	{ID: "codex-gpt-5.1-codex-max", Provider: "openai-codex", Label: "GPT-5.1 Codex Max", APIID: "gpt-5.1-codex-max", Description: "Long-horizon Codex model.", Tags: []string{"coding", "tools"}},
	{ID: "codex-gpt-5.1-codex", Provider: "openai-codex", Label: "GPT-5.1 Codex", APIID: "gpt-5.1-codex", Description: "Earlier Codex model.", Tags: []string{"coding", "tools"}},
	{ID: "codex-gpt-5-codex", Provider: "openai-codex", Label: "GPT-5 Codex", APIID: "gpt-5-codex", Description: "First Codex generation.", Tags: []string{"coding", "tools"}},

	// Anthropic. Fable is the Mythos tier, above Opus.
	{ID: "claude-fable-5-1", Provider: "anthropic", Label: "Claude Fable 5.1", Description: "Deepest reasoning and long-horizon agentic work.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-opus-5-5", Provider: "anthropic", Label: "Claude Opus 5.5", Description: "Long-running agentic coding and knowledge work.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-sonnet-5", Provider: "anthropic", Label: "Claude Sonnet 5", Description: "Best combination of speed and intelligence.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-haiku-4-5", Provider: "anthropic", Label: "Claude Haiku 4.5", Description: "Fastest Claude, near-frontier.", Tags: []string{"fast", "tools"}},
	// The Claude models served through a Claude login (OAuth).
	{ID: "claude-oauth-opus-5-5", Provider: "claude-oauth", Label: "Claude Opus 5.5 (OAuth)", APIID: "claude-opus-5-5", Description: "Flagship reasoning and coding through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-opus-5", Provider: "claude-oauth", Label: "Claude Opus 5 (OAuth)", APIID: "claude-opus-5", Description: "Previous flagship through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-fable-5-1", Provider: "claude-oauth", Label: "Claude Fable 5.1 (OAuth)", APIID: "claude-fable-5-1", Description: "Deepest reasoning and agentic work through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-fable-5", Provider: "claude-oauth", Label: "Claude Fable 5 (OAuth)", APIID: "claude-fable-5", Description: "Mythos tier reasoning through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-sonnet-5-5", Provider: "claude-oauth", Label: "Claude Sonnet 5.5 (OAuth)", APIID: "claude-sonnet-5-5", Description: "Frontier speed and intelligence through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-sonnet-5", Provider: "claude-oauth", Label: "Claude Sonnet 5 (OAuth)", APIID: "claude-sonnet-5", Description: "Balanced Claude through a Claude login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "claude-oauth-haiku-4-5", Provider: "claude-oauth", Label: "Claude 4.5 Haiku (OAuth)", APIID: "claude-haiku-4-5-20251001", Description: "Fast Claude through a Claude login.", Tags: []string{"fast", "tools"}},

	// GitHub Copilot models served through a GitHub login (OAuth).
	// GitHub Copilot models served through a GitHub login. The wire ids are
	// the account's live catalogue at api.githubcopilot.com/models; a Copilot
	// account only serves the entries its policy enables, so models that a
	// given account has disabled are not offered here.
	{ID: "copilot-gpt-5.4", Provider: "github-copilot", Label: "GPT-5.4 (Copilot)", APIID: "gpt-5.4", Description: "Long-context frontier model through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-gpt-5.4-mini", Provider: "github-copilot", Label: "GPT-5.4 Mini (Copilot)", APIID: "gpt-5.4-mini", Description: "Faster GPT-5.4 through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-gpt-5.3-codex", Provider: "github-copilot", Label: "GPT-5.3 Codex (Copilot)", APIID: "gpt-5.3-codex", Description: "Agentic coding model through GitHub Copilot.", Tags: []string{"coding", "tools"}},
	{ID: "copilot-gpt-5.6-terra", Provider: "github-copilot", Label: "GPT-5.6 Terra (Copilot)", APIID: "gpt-5.6-terra", Description: "Balanced GPT-5.6 through GitHub Copilot.", Tags: []string{"reasoning", "tools"}},
	{ID: "copilot-gpt-5.6-luna", Provider: "github-copilot", Label: "GPT-5.6 Luna (Copilot)", APIID: "gpt-5.6-luna", Description: "Efficient GPT-5.6 through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-gpt-6-luna", Provider: "github-copilot", Label: "GPT-6 Luna (Copilot)", APIID: "gpt-6-luna", Description: "Newest efficient GPT through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-claude-sonnet-5-5", Provider: "github-copilot", Label: "Claude Sonnet 5.5 (Copilot)", APIID: "claude-sonnet-5.5", Description: "Frontier Claude through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-claude-sonnet-5", Provider: "github-copilot", Label: "Claude Sonnet 5 (Copilot)", APIID: "claude-sonnet-5", Description: "Balanced Claude through GitHub Copilot.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "copilot-claude-haiku-4-5", Provider: "github-copilot", Label: "Claude Haiku 4.5 (Copilot)", APIID: "claude-haiku-4.5", Description: "Fast Claude through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-gemini-3.8-flash", Provider: "github-copilot", Label: "Gemini 3.8 Flash (Copilot)", APIID: "gemini-3.8-flash", Description: "Fast Gemini through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-gemini-3.6-flash", Provider: "github-copilot", Label: "Gemini 3.6 Flash (Copilot)", APIID: "gemini-3.6-flash", Description: "Balanced Gemini through GitHub Copilot.", Tags: []string{"fast", "tools"}},
	{ID: "copilot-gemini-3.5-flash", Provider: "github-copilot", Label: "Gemini 3.5 Flash (Copilot)", APIID: "gemini-3.5-flash", Description: "Efficient Gemini through GitHub Copilot.", Tags: []string{"fast", "tools"}},
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
	{ID: "antigravity-gemini-3.8-flash", Provider: "antigravity", Label: "Gemini 3.8 Flash (Antigravity)", APIID: "gemini-3.8-flash-medium", Description: "Fast Gemini through an Antigravity login.", Tags: []string{"fast", "tools", "coding"}},
	{ID: "antigravity-gemini-3.5-flash", Provider: "antigravity", Label: "Gemini 3.5 Flash (Antigravity)", APIID: "gemini-3.5-flash-low", Description: "Balanced Gemini through an Antigravity login.", Tags: []string{"fast", "tools"}},
	{ID: "antigravity-gemini-pro", Provider: "antigravity", Label: "Gemini Pro (Antigravity)", APIID: "gemini-pro-agent", Description: "Flagship Gemini through an Antigravity login.", Tags: []string{"reasoning", "tools", "coding"}},
	{ID: "antigravity-claude-sonnet-4-6", Provider: "antigravity", Label: "Claude Sonnet 4.6 (Antigravity)", APIID: "claude-sonnet-4-6", Description: "Claude through an Antigravity login.", Tags: []string{"reasoning", "tools", "coding"}},
	// Meta Muse Code. The device grant mints an account key; the model id is
	// what api.meta.ai serves it under.
	{ID: "muse-spark-1.3", Provider: "muse", Label: "Muse Spark 1.3", APIID: "muse-spark-1.3", Description: "Meta's coding model through a Muse Code login.", Tags: []string{"coding", "tools"}},
	{ID: "claude-opus-5", Provider: "anthropic", Label: "Claude Opus 5", Description: "Previous flagship, still available.", Tags: []string{"reasoning", "tools"}},
	{ID: "claude-sonnet-4-6", Provider: "anthropic", Label: "Claude Sonnet 4.6", Description: "Previous Sonnet generation.", Tags: []string{"tools", "coding"}},

	// Google. The Flash line ships far more often than the Pro one.
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
