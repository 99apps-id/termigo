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
3. Converts UI messages to model messages, prunes reasoning content if the model does not keep it, and compacts old messages to fit the model's context window — the limit compaction targets is the configured window capped by any real cap the provider has reported (see [Context-window auto-recovery](#context-window-auto-recovery)).
4. Streams via `streamText` with the tool set from `buildTools(ctx)` and three stop conditions (below).
5. Emits step labels, usage deltas, and finish metadata including the stop reason.

### Stopping

Three guards end the loop, and each records that it tripped so the transcript can explain the stop rather than offering the same blank Continue for every cause:

- **`step-cap`** - the round's budget, `stepCountIs(stepBudget)`.
- **`tool-repetition`** - `noToolRepetition(3)`: the same tool with the same input three steps running. Inputs are canonicalised (`stableStringify`) so a reshuffled object is not mistaken for progress, and the whole ordered set of parallel calls is compared rather than just the first.
- **`no-progress`** - `noProgressStop(2)`: two consecutive steps that called no tool at all.

The budget escalates instead of being fixed. `AGENT_STEP_BUDGETS` (`config.ts`) is `[25, 50, 100]`: round one matches VS Code agent mode's `chat.agent.maxRequests` default, each Continue climbs a rung via `agentMeta.runRound`, and the last tier repeats. A typed message resets the ladder; only Continue climbs it. A fixed cap has to guess between stalling a refactor and letting a one-line fix burn a hundred steps on a per-token model, and escalation reads the weight from what actually happened instead.

The tool set is assembled in `src/modules/ai/tools/tools.ts` from `fs`, `edit`, `search`, `shell`, `subagent`, `terminal`, `todo`, and `managedAgent` builders.

### One request in flight per session

A `Chat` must never carry two concurrent requests. `Chat.sendMessage` is not serialised through the SDK's `jobExecutor`, and when a round settles the SDK auto-continues into the next tool round a microtask later. A queued steering task is therefore delivered by `flushSteer` only after a macrotask (`setTimeout(0)`) and only while the live `Chat.status` is not busy — the same liveness rule `sendParts` applies via `submitAction`. Delivering into the `ready`→`submitted` gap races the SDK's own continuation, and two loops append to the same transcript at once, roughly doubling it every cycle until compaction and the provider's request-body cap both give out. The stop path passes `bypassBusyCheck` because an aborted round never auto-continues, so there is nothing to race and waiting would strand the queued task.

Compaction (`compact.ts`) is linear in transcript size: each message is measured once and a running byte total is updated by delta on every rewrite. Re-measuring the whole transcript (a full `JSON.stringify`) inside each trim step's break check is O(N²) and froze a large session for minutes. A `write_file` transcript also shrinks the tool-CALL `input` bodies, not just the elided results — otherwise a build's file bodies stay on the wire and the request overflows the body-size cap even when the token estimate fits.


## Sub-agents

`src/modules/ai/agents/registry.ts` defines the sub-agent types: `explore`, `code-review`, `security`, `general`, `builder`, and `pentest`. They differ only in system prompt, not in what they may touch: every type gets the SAME toolset as the main agent (`buildTools` + extension tools), so a sub-agent is a peer that can edit, run commands and drive extensions, not a read-only subset. What keeps that safe is approval, not restriction — `runSubagent` routes every mutating, exec or third-party tool through the user's approval queue (`subagentToolNeedsGate`), exactly as the main agent gates them, so nothing runs without a click. The one capability withheld is `run_subagent` / `run_subagents`: a sub-agent cannot spawn its own sub-agents, so it cannot recurse without bound.

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
- Pending approvals can be answered in a batch. `lib/approvalQueue.ts` accepts a comma/range list (`1,3` or `2,4-6`); `parseApprovalTarget` resolves it against the queued items. The `delete_file` floor still applies in every mode (see [security model](security-model.md#deleting-is-never-delegated)).

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

### Project-scoped approval rules (`.termigo/approvals.json`)

The global mode is a blunt instrument, so per-project **per-tool trust** refines it without loosening it everywhere. Rules live in `.termigo/approvals.json` (`{ version: 1, rules: [...] }`); each rule keys on tool names, a path glob (`src/**`, `**/*.env`) or a command pattern (`git *`, bare patterns are substrings, wildcards are anchored globs), and carries an action: `allow` (auto-run), `deny` (auto-refuse, with an optional `reason`) or `ask` (force a manual prompt even when the mode would wave it through). First match wins.

- **`lib/approvalRules.ts`** — pure matching/parse/serialize; `ruleMatches` (glob → anchored case-insensitive regex), `evaluateApprovalRules` (first match), `ruleFromApproval` (turn one approval into a persisted rule, generalising `git status` → `git *`), `upsertRule` (de-dupe by target), and `subagentRuleGate` (map a decision onto a sub-agent call).
- **`store/approvalRulesStore.ts`** — loads the active workspace's file, evaluates synchronously, persists edits (add / remove / cycle action).
- **Applied to the main agent** in `hooks/useAutoApproval.ts` (deny auto-refuses, allow auto-approves, ask leaves it for the user) **and to sub-agents** in `runSubagent.ts`'s `gate()` via `subagentRuleGate`, so a rule set for the agent holds for its workers. Precedence: an explicit session/global allowance wins, then the rules, then the scoped-scan opt-in, then the mode.
- **Managed from the UI** in `ApprovalModeControl.tsx` (list / cycle / remove) and the per-approval "always allow in this project" affordance in `AiToolApproval.tsx`.

### User-authored slash commands (`.termigo/commands/*.md`)

Alongside the built-in `/init`, `/plan`, `/goal`, `/model`, … a user can author per-project commands: one Markdown file per command under `.termigo/commands/`, frontmatter `description:` for the picker and the body as the prompt template, with `$ARGUMENTS` replaced by whatever the user typed after the name (Claude Code's convention; when the placeholder is absent the arguments are appended).

- **`lib/customCommands.ts`** — `parseCommand` (frontmatter + body), `expandCommand` (`$ARGUMENTS` substitution), `listCustomCommands` (scan, never throws), `isValidCommandName` (the same slug rule skills use, so `../../etc/passwd` cannot be a command).
- **`store/customCommandsStore.ts`** holds the loaded list; `tryRunSlashCommand` (`lib/slashCommands.ts`) resolves `/name` to a built-in or the user's command and emits the expanded prompt.
- **UI** — `AiComposerInput`'s `/` picker lists built-in and custom commands together (custom ones shadowed by a built-in name are hidden), and re-scans `.termigo/commands` when the picker opens so a new file shows up without a restart.

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

## Context meter

`components/ContextMeter.tsx` (mounted in `AiStatusBarControls`) shows the live input token count against the model's context limit (`getModelContextLimit`). The fill bar turns amber above 70% and red above 90%, so the user sees when compaction is about to trigger.

## Context-window auto-recovery

A long agentic task that outgrows the model's context window used to die mid-way: the provider rejects the request, the run errors, and only a manual click started it again. Termigo now recovers automatically.

- **`lib/contextLimitLearning.ts`** learns a model's REAL window from the provider's own overflow error. `parseContextOverflow` reads `maximum context length is N tokens … requested M tokens`; `recordContextOverflow` stores N and sets a budget scale from the overshoot (M/N), so the next request targets ~85% of the cap. `isContextOverflowError` recognises the common error shapes; `effectiveContextLimit` returns the smaller of the configured limit and any learned real cap, times the scale (floored at 8k). A later request with plenty of headroom (`noteSuccessfulRequest`) relaxes the scale back toward 1, so one overflow does not over-compact the model forever.
- **`compact.ts`** pins the budget it must hit and adds two floors so a retry actually fits: a final hard cap that trims the protected tail too (keeping only the last `KEEP_MIN_TAIL` messages intact), and an absolute floor that force-trims any single message larger than the whole window — the case no budget reduction can otherwise fix.
- **Auto-resume.** In `chatRuntime` `onError`, an overflow is recorded and the SAME run is resumed automatically (`resumeRun`) so the task keeps going instead of stopping. A per-session throttle (`overflowAutoResumeAt`, 60s) prevents a loop when compaction can never fit (e.g. the system prompt + tool schemas alone exceed the window). The **Try again** button in `AiChat.tsx` remains as the manual fallback for a second overflow.
- **`config.ts`** keeps the configured limit as the real cap (DeepSeek V4 is 1M). If a specific endpoint rejects lower, the learning layer scales the effective budget down from the observed overshoot — so the config is not a guess.

## Context pruning

Compaction trims messages *by size* but still ships every message on every turn, so a long task keeps re-paying for its finished history. Context pruning goes further: when an early span of the transcript is **verified** — its mutations are saved to git via a successful `git_checkpoint` / `git_commit` — the whole span is replaced by a single user message carrying a compressed checkpoint summary (files changed, files read, commands/checks run with exit status, a compact diff note). The model keeps knowing the current state without the history that produced it.

- **`lib/contextPrune.ts`** `findVerifiedCut` picks the highest safe cut: the prefix must be self-contained (every tool-call inside has its tool-result inside — never a dangling call or orphaned result), contain at least one verified checkpoint, be at least `PRUNE_MIN_VERIFIED_MESSAGES` long, and leave `PRUNE_TAIL_KEEP` trailing messages fully intact. `summarizeSegment` pairs commands/checks by `toolCallId` (not by string-matching the command, which breaks on `run_checks {kind}` overrides) and treats `exit_code ≠ 0` or any `error` as a failure. `formatPruneSummary` caps at 1800 chars.
- **Pipeline order** in `runAgentStream` (`agent.ts`): SDK `pruneMessages` → `compactModelMessagesDetailed` → `evictObsoleteToolOutputs` → `pruneVerifiedPrefix` (last, so it prunes the smallest already-trimmed history). When it fires, `opts.onPrune({ prunedMessages })` surfaces a `PruneNotice` in the chat (`AgentMeta.pruneNotice`).
- **Why it is safe.** A cut only happens on a balanced tool-call/result boundary and after the work is committed to git, so the collapsed span is reproducible from the checkpoint; the summary message is plain text, so provider tool-call/result validation is never affected.

## Transient provider-error recovery

A run can also stop for reasons that are not the model's fault — the internet drops, the provider's quota runs out, or a rate limit is hit. These are recoverable: once the condition clears, the same run should continue, not start over. `chatRuntime` `onError` classifies them:

- **Connectivity loss** (`lib/errors.ts` `isConnectivityError`: unreachable host / tcp connect / fetch failed / `ENETUNREACH` / connection refused / DNS) marks the run resumable and adds the session to `pendingReconnectSessions`; a `window` `online` listener then resumes it automatically when the network is back. A manual **Try again** also works.
- **Mid-stream stall** is a connectivity failure from the run's point of view, and the classifier says so: Rust's own wording — `provider stream stalled (no data for Ns)` (net.rs `AI_STREAM_IDLE_TIMEOUT`, 120 s — a bursty thinking-mode generation can legitimately pause over half a minute) — is matched by `isConnectivityError`, so a genuine stall takes the same transient auto-retry path instead of leaving a dead red card.
- **Quota / credit exhaustion** (`isQuotaError`: `insufficient_quota`, quota, credit, 402) and **rate limits** (`isRateLimitError`: rate_limit, 429, throttle) are recoverable but have no event to watch for — the user tops up or waits, then clicks **Try again**; the task/todo state is preserved.
- **Resume always sends.** `sendParts` keys off `agentMeta.status === "error"` so a resume after a failed run is sent, never queued: the AI SDK status can look `submitted` after an error, which would queue the `RESUME_PROMPT` and leave "Try again" doing nothing.

## Forced tool-choice learning

Two places hand the provider a non-default `tool_choice`: the forced fan-out pin (step 0 → `{ type: "tool", toolName: "run_subagents" }` on a broad request) and the synthesis step (`"none"`). The static guard in `config.ts` (`modelAllowsForcedToolChoice`) only reads reasoning **tags** from the built-in registry — a user-defined OpenAI-compatible endpoint (`compat-*`) has no tags, so it was assumed capable. A Qwen-style "thinking mode" endpoint answers a required/object `tool_choice` with HTTP 400 ("The tool_choice parameter does not support being set to required or object in thinking mode"), which killed the whole request on exactly the broad prompts the fan-out is meant to serve.

- **`lib/toolChoiceLearning.ts`** classifies the rejection (`isToolChoiceRejectionError`) and records the model id (`recordToolChoiceRejection`). In-memory, like `contextLimitLearning`: a wrong guess costs one failed round, and persistence would keep a fixed model un-pinned across restarts.
- **`agent.ts`** `forceFanout` adds `!modelRejectsForcedToolChoice(modelId)` — after one rejection the pin is dropped for that model, and the request succeeds (the model still has `run_subagents`; pinning was an optimisation, not a requirement).
- **`chatRuntime` `onError`** records the rejection and resumes the run once (5 s throttle). The retry sends no pin and is accepted, so the user does not see the failure at all; the manual **Try again** stays as the fallback if even that fails.
- Only the object pin needs the learning — `"none"` is accepted by thinking-mode endpoints, so the synthesis step is unaffected.

## Interrupted-run recovery

A run that is cut off by the app closing (restart, crash) is recoverable, not lost. The transcript is persisted by `AgentRunBridge`, and a marker distinguishes "mid-flight when the app closed" from a deliberate stop.

- **In-flight marker.** `lib/sessions.ts` stores `runInFlight:<id>` when a run starts (`markRunStarted` in `chatStore`, called from the `sendParts` send-branch and `flushSteer`) and clears it when the run settles or errors (`syncRunMeta`, called from `onFinishMeta`, `stopRun`, and every `onError` settle branch). `markRunStarted` also writes a `RunMeta` with no stop so the budget ladder survives.
- **Fresh on boot.** `chatStore.hydrateSessions` always starts on a fresh, empty "New chat" session, so the AI chat window does not reopen with a previous task's history (or an interrupted run). Prior sessions stay in the history list and can be opened from there. `switchSession` applies the same `loadInterruptedPatch` logic, so an interrupted run still offers **Resume** when the user explicitly opens that session.
- **What "interrupted" means.** A `RunMeta` with a stop (user stop, guard, cost-cap) restores that stop's `Continue`. A `RunMeta` with no stop but a live in-flight marker — or a marker with no `RunMeta` — means the app closed mid-run and is restored as `stopReason: "interrupted"`, offering **Resume**. `runInterruptedPatch` (pure, exported for tests) decides.
- **Resume path.** The transcript shows a **Resume** row (`AiChat.tsx` `stopCopy` case `"interrupted"`); clicking it runs `resumeRun`, which bumps `runRound` and sends `RESUME_PROMPT` through `sendParts`, re-marking the run in flight.

## BatikCode-parity agent UX

Features adopted from the BatikCode (VS Code fork) agent host, adapted to Termigo's in-process agent loop:

- **Sub-agent nesting depth.** `agents/runSubagent.ts` exports `MAX_SUBAGENT_DEPTH` (3) and `effectiveSubagentMaxDepth()` reads the `subagentMaxDepth` preference (clamped 1–5). A subagent at depth N spawns children at depth N+1 via `buildSubagentTools(ctx, depth)`; at the cap the spawn tools (`run_subagent` / `run_subagents`) are withheld (`spawnToolsWithheld`) so recursion cannot loop.
- **Cost-tier guard.** `config.ts` `subagentModelExceedsBudget(sub, main)` (default multiplier 1.5) decides whether a configured subagent model is too expensive relative to the main model; `runSubagent` falls back to the main model when it is. Unpriced models (custom/local endpoints) return null and are allowed.
- **Persisted subagent runs.** `store/subagentRunStore.ts` persists finished runs to LazyStore `termigo-subagent-runs.json` (debounced 300ms), with `depth` and `steps` per run; `ensureSubagentRunsHydrated()` loads before use; `clearSession` deletes from disk.
- **Rotating thinking phrase.** `AiChat.tsx` `useRotatingPhrase` cycles Processing / Preparing / Loading / Analyzing / Evaluating instead of a bare "Round N" label (BatikCode style — no round counters in the UI). `TrajectoryThinkingHUD` shows the same phrase.
- **Modified-files chips.** `components/ai-elements/tool.tsx` `modifiedFilesFromOutput` + `ModifiedFilesChips` render edited/created/deleted/moved paths from tool output.
- **Live background output.** `BashBackgroundLiveOutput` polls `native.shellBgLogs(handle, offset)` (800ms, 64 KB tail cap, auto-scroll, status/exit/dropped) inside the tool card; `bash_background` reads `handle` as a number; `tailForDisplay` caps `BashRunOutput` at 96 KB.
- **Elicitation (`ask_user`).** `tools/elicitation.ts` + `store/elicitationStore.ts` + `components/ElicitationCarousel.tsx`: the agent asks a 2–6-option question rendered as clickable cards; the pick returns as the tool result (BatikCode `chatQuestionCarouselPart` parity).
- **Edit & resend.** User messages get an edit button that prefills the composer (`chatStore` prefill mechanism) for re-send.
- **Artifacts panel.** `store/artifactsStore.ts` (per-session, cap 50) records canvases (`render_view`), previews (`open_preview`), and files (`write_file`) the agent produced; `lib/artifactOpen.ts` is a module-level opener registry (mirrors `setLspNavigator`); `components/ArtifactsDialog.tsx` (Layers02 button in `AiStatusBarControls`) lists and reopens them — files in the editor, previews/canvases in preview tabs. `App.tsx` registers `setArtifactOpener`; `chatStore.deleteSession` clears the session's artifacts.
- **Post-execution confirmation.** Opt-in `confirmAfterMutations` preference (default off). `lib/postExecuteConfirm.ts` wraps the mutating tools (`write_file`, `edit`, `multi_edit`, `bash_run`) so a successful run registers a confirmation in `store/confirmationStore.ts` and awaits the user's **Keep / Revert** before the agent continues (BatikCode `PendingResultConfirmation` parity). Revert is best-effort `git restore` of the touched paths via the shared session shell; a dismissed/aborted confirmation keeps the change (never auto-reverts). UI: `components/ConfirmationCarousel.tsx` mounted next to the elicitation carousel; toggle in Settings → Agents.

### Dev-server orchestration (`dev_server`)

One tool turns "run the app and show me" into a started, opened, controllable dev server in the browser pane — the piece VS Code / BatikCode lack (there the agent runs a terminal task and the user opens the browser themselves). It composes the background shell + preview + browser tools, plus two pieces ported or added for it:

1. **Detect** — `lib/devServer.ts` (`detectDevCommand`) resolves the project's dev command from `package.json` scripts (`dev` → `start` → `serve` → `develop` → `dev:web`) and a port hint: an explicit `--port N` / `-p N` / `PORT=N` / `:N` in the command, else a framework default (Vite 5173, Next 3000, Webpack 8080, Cargo/Go 8000, …).
2. **Spawn (deduped)** — spawns via `bash_background`, but first lists running background processes (`bash_list`) and reuses an identical dev server instead of stacking a second one.
3. **Learn the real URL** — `lib/devUrl.ts` ports TEDI's `findLocalUrl`: it strips ANSI escapes (Vite prints the port in bold, which used to split the match), picks the last `http(s)://localhost|127.0.0.1|0.0.0.0` URL, rewrites `0.0.0.0` → `127.0.0.1` (a bind address, never a connect one) and drops trailing punctuation. The tool tails `bash_logs` with it until a URL appears — so the port, path and host the server ACTUALLY chose are used, not a guess.
4. **Health-probe** — the Rust `http_probe` command (`net.rs`) GETs the URL with a short timeout, no redirects, and — the inverse of `ai_http_request`'s guard — accepts **only loopback** hosts (localhost / 127.0.0.1 / ::1), because it exists purely to wait on a local server the agent spawned.
5. **Open + control** — once the URL responds (a 4xx still counts as up), `dev_server` opens it via `open_preview` (`instance` `dev-<handle>`) and returns the handle, URL and a log tail; the `browser_*` tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_eval`, `browser_extract`, `browser_screenshot`) then drive the page, and `bash_logs`/`bash_kill` watch or stop the server.

On a remote SSH session the tool refuses and points at the composed path (`bash_run` + `forward_remote_port` + `open_preview`) instead.

## Scheduled runs

`lib/scheduler.ts` lets the user queue an agent prompt to run on a schedule. The pure helpers (`parseScheduleWhen`, `computeNextDueAt`, `dueTasks`) are unit-tested; `startScheduler`/`stopScheduler` run a 15-second tick that lazily imports `chatStore`, `sessionDirectiveStore`, and `chatRuntime` inside the tick so the AI stack stays out of the eager bundle.

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
- **Sub-agents** (`agents/registry.ts`, `agents/runSubagent.ts`, `tools/subagent.ts`): named sub-agents with their own system prompts, each holding the full main-agent toolset (minus the spawner tools). `run_subagent` spawns one; `run_subagents` spawns a batch, which is the one to reach for. A batch runs independent tasks concurrently (bounded by `max_concurrency`), and a task's `depends_on` makes it wait for others and receive their summaries, so a synthesising task can be handed what the others gathered. A sub-agent's read-only tools auto-execute while its mutating, shell and extension calls go through the approval queue; each has a fresh history, so every prompt must stand alone. Step 0 is pinned to a fan-out via `toolChoice` (`lib/orchestrationIntent.ts`) only for a broad *study* request, because asking for one in the prompt gets ignored.

  Note what that excludes: the classifier fires on study verbs (audit, explore, understand) plus a breadth cue, not on creation. "Build me a website" and "build the frontend and the backend" are measured as ordinary requests, and rightly so — creating something usually means touching shared files in a defined order, which is safer to hand to the main agent than to scatter across sub-agents. This is a *scheduling* choice, not a capability limit: a sub-agent holds the full main-agent toolset (approval-gated) and can build, edit and run commands; it is simply not fanned out for a creation request by default.
- **Sessions** (`lib/sessions.ts` + `store/chatStore.ts`): conversations are organized into named sessions, persisted via `tauri-plugin-store` at `termigo-ai-sessions.json` (list + `activeId` + per-session `messages:<id>` keys). `chatStore.ts` keeps a module-scoped `Map<sessionId, Chat<UIMessage>>`; `getOrCreateChat(apiKey, sessionId)` lazily constructs a `Chat`, seeded with messages from a hydration map populated by `hydrateSessions()` (called once from `App.tsx`). `AgentRunBridge` mirrors active-session messages to disk on every change and auto-derives titles from the first user message. Switching the API key wipes the chat map; sessions persist.
- **Composer** (`lib/composer.tsx`): React context providing shared input state (text, attachments, voice) for both the docked `AiInputBar` and any other surface. Attachments include image, text-file, and `selection` kinds - selections come from `useChatStore.attachSelection(text, source)` (drained into chips, not pasted into the textarea) and are wrapped as `<selection source="terminal|editor">…</selection>` blocks at submit. Composer derives `isBusy` from `agentMeta.status` so it can mount safely before sessions hydrate.
- **Voice input**: streamed transcription pipeline. Toggled from the composer.
- **Live context bridge**: `App.tsx` calls `setLive({ getCwd, getTerminalContext, … })` so tools can read the *currently active* terminal's cwd + last 300 lines of buffer. Lazy by design - don't pre-snapshot.
- **Tools** (`tools/tools.ts`): `read_file`, `list_directory`, `grep`, `glob`, `get_terminal_output` auto-execute. `edit`, `multi_edit`, `write_file`, `create_directory`, `move_file`, `copy_file`, `delete_file`, `replace_in_files`, `bash_run`, `bash_background`, `fetch` and the agent hand-offs set `needsApproval: true` and the AI SDK pauses for an in-UI confirmation card. `lib/security.ts` is a deny-list refusing obvious secret paths (`.env*`, `.ssh/`, credentials, keychain dirs) - apply on **both** read and write paths and don't bypass it.
- **Approval resume - the trailing message is load-bearing.** Auto-send after approval uses `lastAssistantMessageIsCompleteWithApprovalResponses`, and `streamText` then executes the approved call. It finds the approval in exactly one place: `collectToolApprovals` reads `messages.at(-1)` and returns nothing unless that message is the `tool` message carrying the response. So **nothing may be appended after an answered approval.** The `<env>` block did exactly that and cost three releases: the approved command never ran, and the provider rejected the history with "must be followed by tool messages responding to each `tool_call_id`", which reads as a corrupted session rather than a broken approval. `isResumingApproval` (`lib/transport.ts`) holds the block back for that one case. Anything else that wants to append to the outgoing copy has to check the same thing.
- **Edit diffs**: AI-proposed edits open in a side-by-side diff tab (`ai-diff` tab kind); user accepts/rejects per hunk before the write tool actually runs.
- **Prompt snippets** (`#handle`): reusable prompt fragments surfaced in the composer. Do not describe these as skills; a reusable tool-bundled skills system is not implemented yet.
