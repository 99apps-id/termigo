# AI subsystem

This guide elaborates on `TERMIGO.md`. If anything here conflicts with `TERMIGO.md`, `TERMIGO.md` wins.

## Overview

The AI subsystem is BYOK (bring your own key). It supports cloud providers via `@ai-sdk/*` and local / offline providers via OpenAI-compatible endpoints. The agent layer is built on Vercel AI SDK v6 chat semantics: `streamText`, tool definitions, and `stopWhen` step limits.

Main entry point: `runAgentStream` in `src/modules/ai/lib/agent.ts`.

## Providers

Cloud providers are defined in `src/modules/ai/config.ts`:

- OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter
- `openai-compatible` for any custom base URL
- Local: LM Studio, MLX, Ollama

`buildLanguageModel` in `src/modules/ai/lib/agent.ts:76` branches on `provider` to construct the correct AI SDK provider instance. Local providers use `createOpenAICompatible` with a `localProxyFetch` that allows private-network access, while cloud providers use their dedicated SDK constructors.

Model metadata (context limits, costs, reasoning behavior) lives in the model registry in `config.ts`. `resolveModel` maps a model id to its provider and defaults.

### Adding a new provider

1. Add a `ProviderInfo` entry to `PROVIDERS` in `src/modules/ai/config.ts`.
2. Add model ids and metadata to the model registry in the same file.
3. Add a branch in `buildLanguageModel` (`src/modules/ai/lib/agent.ts:99`) that constructs the provider instance. For OpenAI-compatible APIs you can often reuse `createOpenAICompatible`.
4. If the provider requires an API key, update `providerNeedsKey` in `config.ts` and the keyring service mapping.
5. If it needs a dedicated `@ai-sdk/*` package, add it to `package.json` and justify the bundle cost (see `CONTRIBUTING.md`).
6. New built-ins must justify unique value beyond `openai-compatible` and OpenRouter; `CONTRIBUTING.md` calls this out explicitly.

Keys are never persisted outside the OS keychain / Linux secrets file.

## Agent run loop

`runAgentStream` (`agent.ts:391`):

1. Resolves the model via `buildConfiguredLanguageModel`.
2. Builds a stable system prompt from `selectSystemPrompt(modelId)` plus optional persona, custom instructions, and `TERMIGO.md` project memory.
3. Converts UI messages to model messages, prunes reasoning content if the model does not keep it, and compacts old messages if the context limit is exceeded.
4. Streams via `streamText` with the tool set from `buildTools(ctx)` and three stop conditions (below).
5. Emits step labels, usage deltas, and finish metadata including the stop reason.

### Stopping

Three guards end the loop, and each records that it tripped so the transcript can explain the stop rather than offering the same blank Continue for every cause:

- **`step-cap`** - the round's budget, `stepCountIs(stepBudget)`.
- **`tool-repetition`** - `noToolRepetition(3)`: the same tool with the same input three steps running. Inputs are canonicalised (`stableStringify`) so a reshuffled object is not mistaken for progress, and the whole ordered set of parallel calls is compared rather than just the first.
- **`no-progress`** - `noProgressStop(2)`: two consecutive steps that called no tool at all.

The budget escalates instead of being fixed. `AGENT_STEP_BUDGETS` (`config.ts`) is `[25, 50, 100]`: round one matches VS Code agent mode's `chat.agent.maxRequests` default, each Continue climbs a rung via `agentMeta.runRound`, and the last tier repeats. A typed message resets the ladder; only Continue climbs it. A fixed cap has to guess between stalling a refactor and letting a one-line fix burn a hundred steps on a per-token model, and escalation reads the weight from what actually happened instead.

The tool set is assembled in `src/modules/ai/tools/tools.ts` from `fs`, `edit`, `search`, `shell`, `subagent`, `terminal`, `todo`, and `managedAgent` builders.

## Sub-agents

`src/modules/ai/agents/registry.ts` defines read-only sub-agents: `explore`, `code-review`, `security`, and `general`. Each has a whitelist of tools and its own system prompt. Sub-agents cannot recurse (the subagent tool set excludes the spawner tools themselves).

Two spawners live in `tools/subagent.ts`. `run_subagent` runs one. `run_subagents` takes a batch and is the one to prefer: independent tasks run concurrently up to `max_concurrency`, and a task's `depends_on` makes it wait for the tasks it names and receive their summaries as context — scatter, then gather. A task whose dependency failed is skipped rather than run without it; cycles and self-references are rejected; tasks beyond the cap are dropped and reported in `note` rather than silently. Each sub-agent starts with a fresh history, so a prompt that leans on the parent conversation will not work — dependency summaries are the only context injected.

Fan-out on step 0 is forced rather than requested. `lib/orchestrationIntent.ts` classifies the request and, when it is broad, `prepareStep` pins step 0 with `toolChoice: { type: "tool", toolName: "run_subagents" }`. A prompt asking the model to parallelise is ignored often enough to be useless. The classifier is deliberately conservative in one direction: "don't use subagents for this" and questions *about* sub-agents must not trigger a fan-out, since forcing one there is the worst possible reading of the request.

## Sessions

Conversations are organized into sessions. Persistence lives in `termigo-ai-sessions.json` via `tauri-plugin-store` (`src/modules/ai/lib/sessions.ts`):

- `sessions` key: list of session metadata
- `activeId` key: active session id
- `messages:<id>` keys: per-session messages, loaded lazily

`AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message.

## Composer

`AiComposerProvider` (`src/modules/ai/lib/composer.tsx`) is a React context that holds shared input state (text, attachments, voice) for the docked input bar and any other surface. Attachments can be images, text files, or `selection` chips from the terminal or editor. Selections are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit time and are not pasted into the textarea.

The composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.

## Tools and approval

Tool definitions live under `src/modules/ai/tools/`:

- Read-only tools (`read_file`, `list_directory`, `grep`, `glob`) auto-execute after passing the security deny-list.
- Mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`, `bash_run`, `bash_background`) set `needsApproval: true`. The AI SDK pauses and the UI renders an approval card.
- `edit` / `multi_edit` enforce a read-before-edit invariant: the model must have read the file earlier in the session.
- In plan mode, mutating tools queue edits for batch review instead of applying them immediately.

### Approval resume: nothing may follow the approval

Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`, and `streamText` executes the approved call on the next request. It finds the approval in one place only:

```js
// collect-tool-approvals.ts
const lastMessage = messages.at(-1);
if (lastMessage?.role != "tool") {
  return { approvedToolApprovals: [], deniedToolApprovals: [] };
}
```

`convertToModelMessages` turns an answered approval into a trailing `tool` message holding the response — it survives `pruneMessages` and compaction intact. But **anything appended after it silently disables the whole approval mechanism**: `streamText` finds no approvals, never runs the tool, and forwards an assistant `tool_calls` with nothing answering it. The provider then rejects the request with "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'" — an error that names the conversation history, not the approval, which is why it reads as a corrupted session.

The `<env>` block did exactly this, and it cost three releases of fixes aimed at the sanitiser before the cause was found. `isResumingApproval` (`lib/transport.ts`) now holds the block back for that one case; an ordinary continuation still gets it, because that history already ends in a `tool` message of results.

Two things follow for anyone changing this area:

- Anything new that appends to the outgoing copy must check `isResumingApproval` first.
- Do not "fix" a dangling `tool_calls` by switching to `lastAssistantMessageIsCompleteWithToolCalls`. It requires every call to reach `output-available` or `output-error`, and only `streamText` can put it there — which needs the send that condition withholds. Approving a command would hang silently instead of failing loudly.

`isAutoApproved` (`lib/approvalPolicy.ts`) decides what a mode may skip. Ahead of every branch — including the `all` shortcut — sits a floor no mode delegates: `delete_file`, and any tool carrying a `command` that `deletesFiles` recognises. See [security model](security-model.md#deleting-is-never-delegated).

## Transport

`proxyFetch` (`lib/proxyFetch.ts`) routes provider calls through the Rust `ai_http_stream` command rather than the webview's own `fetch`, so keys and SSRF checks stay off the page. Bodies do not cross as `number[]`: JSON writes that as decimal digits and commas, measured at 3.0x the payload, and an agent re-sends the whole conversation on every step. A request body is already a JSON string and now travels as itself (`{ kind: "text" }`); binary bodies pay base64 (`{ kind: "base64" }`). Response chunks use base64 because a chunk boundary can split a UTF-8 sequence — and because every channel message under 8 KB is injected into the webview as JavaScript source, so inflation there is script the engine then has to parse, once per chunk.

### Inspecting a request

`debugCaptureEnabled` (Settings → Agents → Diagnostics) makes `runAgentStream` record each assembled request into `store/debugStore.ts`, read back by `components/DebugRequestsDialog.tsx` from the AI bar. A capture holds the system messages, the message array after pruning and compaction, the resolved tool set, and the step's params (budget, context limit, how much compaction dropped).

Four constraints shape it:

- **Nothing is persisted.** A capture is the whole conversation; it lives in memory while the window is open and nowhere else. The store is capped at 30 so a hundred-step round cannot pin an entire run.
- **No secrets.** The snapshot is taken where the request is assembled, before the provider SDK attaches credentials.
- **The viewer is in the main window.** Settings is a separate webview and cannot see the main window's memory. The toggle stays in settings because a preference syncs across both.
- **`captureDebug` arrives through `Deps` like `stepBudget`**, rather than `agent.ts` reading preferences directly, which keeps the settings store out of a module the tests import.

Captures are shown as JSON rather than reformatted prose: a debug view that reshapes its subject is not much of a debug view, and the tool list in particular is most useful exactly as the model received it.

### When a request fails

`formatAiError` (`lib/errors.ts`) turns a provider rejection into the text shown in the chat, stripping bearer tokens and API keys on the way. `transport.ts` wraps it so the same text is also written to the app log — `%LOCALAPPDATA%\<identifier>\logs\Termigo.log` on Windows, the platform log directory elsewhere, via `tauri-plugin-log`. AI requests are made from the webview, so before this nothing about them reached that file, which records only the Rust side: a run that died mid-stream left no trace, and diagnosing one meant catching the message on screen before it scrolled away. The formatted text is logged rather than the raw error, because the raw value still carries the request headers.

## Edit diffs

AI-proposed file edits open in an `ai-diff` tab. The user accepts or rejects per hunk. Only after acceptance does the `write_file` or `edit` tool actually run. This keeps the approval UI decoupled from the tool execution.

## Live context bridge

`App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the currently active terminal's cwd and the last 300 lines of buffer. It is lazy by design - tools call for it only when needed rather than pre-snapshotting every turn.

## Invariants

- Keep the Vercel AI SDK v6 chat shape (`streamText`, tools, step limits); the rest of the UI depends on it.
- Keys only via `secrets_*` commands; never disk, settings store, or `localStorage`.
- New providers must justify their bundle cost and unique value.
- Mutating tools require approval; read-only tools still pass the deny-list.
- Deleting is never delegated: no approval mode may skip `delete_file` or a command that removes files.
- Nothing unresolved reaches the provider: every tool call without a result is closed out as interrupted, never deleted.

## See also

- [`TERMIGO.md`](../../TERMIGO.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [Security model](security-model.md) - the boundaries every tool must respect

## Implementation notes

Moved verbatim from `TERMIGO.md` when that file was trimmed to fit the 10 KB of project memory the agent is given. Where this repeats a section above, the section above is the fuller account.

BYOK. Cloud providers via `@ai-sdk/*`: **OpenAI, Anthropic, Google, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter**, plus **OpenAI-compatible** for any custom base URL. Local / offline providers (key-optional, model id supplied at runtime): **LM Studio, MLX, Ollama**. Provider list in `config.ts` (`PROVIDERS`); model registry includes `DEFAULT_MODEL_ID` + `DEFAULT_AUTOCOMPLETE_MODEL`.

- **Key storage**: OS keychain via `keyring` (Rust). Frontend reads/writes through `secrets_*` commands. Service `KEYRING_SERVICE = "termigo-ai"`. Never persist keys to disk, settings store, or `localStorage`.
- **Agent** (`lib/agent.ts`): `Experimental_Agent` with the system prompt from `config.ts` and three stop conditions, each recording which tripped so `onFinishMeta` can report a named `AgentStopReason` instead of a bare "hit the cap": the round's `stepCountIs(stepBudget)`, `noToolRepetition(3)` (same tool, same canonicalised input, three steps running), and `noProgressStop(2)` (two consecutive tool-less steps). The budget escalates per Continue via `AGENT_STEP_BUDGETS` `[25, 50, 100]` (round one matches VS Code agent mode's default), tracked as `agentMeta.runRound` and reset by a typed message. Provider branching happens here - keep the `Agent` / `DirectChatTransport` shape; the rest of the system depends on AI SDK v6 chat semantics.
- **Sub-agents** (`agents/registry.ts`, `agents/runSubagent.ts`, `tools/subagent.ts`): named sub-agents with their own system prompts and tool subsets. `run_subagent` spawns one; `run_subagents` spawns a batch, which is the one to reach for. A batch runs independent tasks concurrently (bounded by `max_concurrency`), and a task's `depends_on` makes it wait for others and receive their summaries, so a synthesising task can be handed what the others gathered. Subagents are read-only and auto-execute; each has a fresh history, so every prompt must stand alone. Step 0 is pinned to a fan-out via `toolChoice` (`lib/orchestrationIntent.ts`) only for a broad *study* request, because asking for one in the prompt gets ignored.

  Note what that excludes: the classifier fires on study verbs (audit, explore, understand) plus a breadth cue, not on creation. "Build me a website" and "build the frontend and the backend" are measured as ordinary requests, and rightly so - a sub-agent's tools are `read_file`, `list_directory`, `grep`, `glob`, and it returns a summary. It cannot build anything. Documentation that implied otherwise was corrected.
- **Sessions** (`lib/sessions.ts` + `store/chatStore.ts`): conversations are organized into named sessions, persisted via `tauri-plugin-store` at `termigo-ai-sessions.json` (list + `activeId` + per-session `messages:<id>` keys). `chatStore.ts` keeps a module-scoped `Map<sessionId, Chat<UIMessage>>`; `getOrCreateChat(apiKey, sessionId)` lazily constructs a `Chat`, seeded with messages from a hydration map populated by `hydrateSessions()` (called once from `App.tsx`). `AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message. Switching the API key wipes the chat map; sessions persist.
- **Composer** (`lib/composer.tsx`): React context providing shared input state (text, attachments, voice) for both the docked `AiInputBar` and any other surface. Attachments include image, text-file, and `selection` kinds - selections come from `useChatStore.attachSelection(text, source)` (drained into chips, not pasted into the textarea) and are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit. Composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.
- **Voice input**: streamed transcription pipeline. Toggled from the composer.
- **Live context bridge**: `App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the *currently active* terminal's cwd + last 300 lines of buffer. Lazy by design - don't pre-snapshot.
- **Tools** (`tools/tools.ts`): `read_file`, `list_directory`, `grep`, `glob`, `get_terminal_output` auto-execute. `edit`, `multi_edit`, `write_file`, `create_directory`, `move_file`, `copy_file`, `delete_file`, `replace_in_files`, `bash_run`, `bash_background`, `fetch` and the agent hand-offs set `needsApproval: true` and the AI SDK pauses for an in-UI confirmation card. `lib/security.ts` is a deny-list refusing obvious secret paths (`.env*`, `.ssh/`, credentials, keychain dirs) - apply on **both** read and write paths and don't bypass it.
- **Approval resume - the trailing message is load-bearing.** Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`, and `streamText` then executes the approved call. It finds the approval in exactly one place: `collectToolApprovals` reads `messages.at(-1)` and returns nothing unless that message is the `tool` message carrying the response. So **nothing may be appended after an answered approval.** The `<env>` block did exactly that and cost three releases: the approved command never ran, and the provider rejected the history with "must be followed by tool messages responding to each `tool_call_id`", which reads as a corrupted session rather than a broken approval. `isResumingApproval` (`lib/transport.ts`) holds the block back for that one case. Anything else that wants to append to the outgoing copy has to check the same thing.
- **Edit diffs**: AI-proposed edits open in a side-by-side diff tab (`ai-diff` tab kind); user accepts/rejects per hunk before the write tool actually runs.
- **Prompt snippets** (`#handle`): reusable prompt fragments surfaced in the composer. Do not describe these as skills; a reusable tool-bundled skills system is not implemented yet.
