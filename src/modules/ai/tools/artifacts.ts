import { tool } from "ai";
import { z } from "zod";

// Artifact broker (omp-inspired blob store).
//
// Large tool results - a full search dump, a build log, a page of JSON - eat
// the context window and stay there for the rest of the run. The model can
// route that payload here instead: `artifact_write` stores it OUT of context
// and hands back a short id, and `artifact_read` pulls back only the slice it
// needs (by line range). Nothing touches disk or the shell, so the tools
// auto-execute like `think` - they change no workspace state.
//
// The store is in-memory and session-scoped on purpose: it is a scratch space
// for the current run, not a document store, so it needs no path guard, no
// approval, and no cleanup. It is bounded so a runaway loop cannot grow the
// heap without limit; the oldest artifact is evicted first.

/** Cap on retained artifacts, so a loop cannot accumulate them without bound. */
export const MAX_ARTIFACTS = 32;

/** Cap on the total retained payload, in UTF-8 bytes. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

export type Artifact = {
  id: string;
  label: string;
  content: string;
  /** UTF-8 byte length of the content. */
  bytes: number;
  /** Line count, so the model knows the addressable range. */
  lines: number;
  createdAt: number;
};

const store = new Map<string, Artifact>();
let seq = 0;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function totalBytes(): number {
  let total = 0;
  for (const a of store.values()) total += a.bytes;
  return total;
}

/** Evict oldest first until both caps hold. */
function enforceCaps(): void {
  while (
    store.size > MAX_ARTIFACTS ||
    (totalBytes() > MAX_ARTIFACT_BYTES && store.size > 1)
  ) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Store content and return its record. Shared with the tool and tests. */
export function putArtifact(content: string, label = "artifact"): Artifact {
  const id = `art-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const record: Artifact = {
    id,
    label,
    content,
    bytes: byteLength(content),
    lines: countLines(content),
    createdAt: Date.now(),
  };
  store.set(id, record);
  enforceCaps();
  // If the new artifact was itself evicted (single payload over the byte cap
  // with no others to drop), the caller still needs a usable answer.
  return store.get(id) ?? record;
}

export function getArtifact(id: string): Artifact | undefined {
  return store.get(id);
}

export function listArtifacts(): Artifact[] {
  return [...store.values()];
}

/** Test hook: clear the store between suites. */
export function resetArtifacts(): void {
  store.clear();
  seq = 0;
}

/** Slice `content` by line range. `offset` is 0-based. */
export function sliceLines(
  content: string,
  offset: number,
  limit: number,
): { text: string; start: number; end: number; total: number } {
  const lines = content.split("\n");
  const total = lines.length;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.max(start, Math.min(start + limit, total));
  return { text: lines.slice(start, end).join("\n"), start, end, total };
}

export function buildArtifactTools() {
  return {
    artifact_write: tool({
      description:
        "Store a large text payload OUT of the conversation and get back a short id. Use this for bulky intermediate results you will not need in full (a big search/JSON/build dump): write it here, keep only the id and a one-line summary in your reasoning, then pull back just the part you need with artifact_read. The store is in-memory and session-scoped (nothing is written to disk), bounded to " +
        `${MAX_ARTIFACTS} artifacts / ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)} MB, oldest evicted first. Auto-executes.`,
      inputSchema: z.object({
        content: z.string().describe("The text to store."),
        label: z
          .string()
          .optional()
          .describe("Short human label, e.g. 'git diff main..HEAD'."),
      }),
      execute: async ({ content, label }) => {
        const a = putArtifact(content, label ?? "artifact");
        return {
          id: a.id,
          label: a.label,
          bytes: a.bytes,
          lines: a.lines,
        };
      },
    }),

    artifact_read: tool({
      description:
        "Read a slice of a stored artifact by its id, addressed by line range. Use it to pull back only the part of a large payload you need instead of re-deriving it. Omit offset/limit to read from the top with a default window.",
      inputSchema: z.object({
        id: z.string().describe("Id returned by artifact_write."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based first line to read (default 0)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Max lines to read (default 200)."),
      }),
      execute: async ({ id, offset, limit }) => {
        const a = getArtifact(id);
        if (!a) {
          return {
            error: `unknown artifact id "${id}". Artifacts are session-scoped and evicted oldest-first once the store is full.`,
          };
        }
        const slice = sliceLines(a.content, offset ?? 0, limit ?? 200);
        return {
          id: a.id,
          label: a.label,
          offset: slice.start,
          limit: slice.end - slice.start,
          totalLines: slice.total,
          truncated: slice.end < slice.total,
          text: slice.text,
        };
      },
    }),

    artifact_list: tool({
      description:
        "List the artifacts stored this session (id, label, size, line count), oldest first. Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          count: store.size,
          artifacts: listArtifacts().map((a) => ({
            id: a.id,
            label: a.label,
            bytes: a.bytes,
            lines: a.lines,
          })),
        };
      },
    }),
  } as const;
}
