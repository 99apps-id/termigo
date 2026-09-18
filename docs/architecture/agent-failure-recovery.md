# Agent failure recovery

What the agent is told to do when a dependency of the run fails. The short form
ships in `SYSTEM_PROMPT` (`src/modules/ai/config.ts`); this file is the
longer-form rationale and the per-capability fallback list.

The guiding rule: a failure is information, not a dead end. Every branch ends
with the agent naming the capability that failed, quoting the error, and saying
what it did instead. Stopping silently, or retrying a dead call in a loop, is
the bug this section exists to prevent.

## MCP server

Symptom: the server fails to spawn, the handshake times out, or a tool call
returns a transport error.

An MCP server contributes tools dynamically. When it goes down, the tools it
exposed vanish for the rest of the run, and no amount of retrying brings them
back. The agent should read the server's own output (`bash_logs`,
`get_terminal_output`), retry the connector at most once, then continue with the
built-in equivalents (file, shell, git, `code_search`). The user is told which
server is down so they can fix the connection.

## HTTP request

Symptom: a fetch or request tool returns a non-2xx status, times out, or fails
DNS resolution.

The status code is the diagnosis, so it must be read before concluding:
`401`/`403` means credentials or a missing token, `404`/`410` means the endpoint
moved or is gone, `429` means back off, `5xx` means retry with backoff. The agent
then switches source (a different endpoint, a local cached file, the CLI
equivalent) instead of repeating the same call. The same request is never
retried more than twice without changing an input.

## find_tools

Symptom: the discovery call errors, or a keyword returns nothing.

A miss is not proof that a capability is absent, because tools are loaded on
demand and the index is keyword-matched. The agent retries with one simpler
keyword, then with the tool name verbatim. If discovery itself is down, it says
so and continues with the tools already loaded, naming the capability it could
not reach.

## LLM request

Symptom: rate limit, context overflow, a provider 4xx/5xx, or an aborted stream.

A context overflow and a rate limit look similar in the logs but need opposite
responses. On overflow the agent saves its progress to a file, summarizes, and
restarts with a smaller slice. On a rate limit it waits and retries with
backoff. On a provider error it retries once, then names the provider and model
that failed. The user's request is never silently shortened to make it fit.

## Subagent spawn

Symptom: concurrency limit reached, no worktree available, or a provider error.

The subagent pool is bounded (default 4 concurrent, 2 nested). A failed spawn is
a scheduling problem, not a failed task: the agent waits for a running task,
does the work itself in the current turn, or shrinks the batch. When a subagent
does run and returns an error, that error is surfaced and the work is finished
directly rather than dropped.

## Why the prompt carries this

The prompt is cached (Anthropic gets a 1h cache breakpoint on the stable system
message), so this guidance costs one cache write per session and is then free.
It lives in `SYSTEM_PROMPT` rather than a tool description because it has to be
in scope before any tool call is attempted.

`SYSTEM_PROMPT_LITE`, used by smaller models, keeps only the substantive output
rules; the failure matrix above is deliberately in the full prompt only.
