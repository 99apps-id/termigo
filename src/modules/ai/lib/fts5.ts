import { LazyStore } from "@tauri-apps/plugin-store";

const STORE_PATH = "termigo-ai-search-index.json";

let store: LazyStore | null = null;

export type SearchHit = {
  sessionId: string;
  messageId: string;
  text: string;
};

export type SearchResult = {
  hits: SearchHit[];
  total: number;
};

async function getStore(): Promise<LazyStore> {
  if (!store) {
    store = new LazyStore(STORE_PATH, { autoSave: true });
  }
  return store;
}

export async function indexMessagesBatch(
  sessionId: string,
  items: Array<{ messageId: string; text: string }>,
): Promise<void> {
  const valid = items
    .map((i) => ({ messageId: i.messageId, text: i.text.trim() }))
    .filter((i) => i.text.length > 0);
  if (valid.length === 0) return;

  const s = await getStore();
  const raw = (await s.get("index")) as SearchHit[] | undefined;
  const idsToRemove = new Set(valid.map((v) => `${sessionId}:${v.messageId}`));
  const entries: SearchHit[] = Array.isArray(raw)
    ? raw.filter((h) => !idsToRemove.has(`${h.sessionId}:${h.messageId}`))
    : [];

  for (const item of valid) {
    entries.push({ sessionId, messageId: item.messageId, text: item.text });
  }

  // hard cap: keep most recent entries only
  const MAX = 8000;
  while (entries.length > MAX) entries.shift();

  await s.set("index", entries);
}

export async function deleteSessionFromIndex(sessionId: string): Promise<void> {
  const s = await getStore();
  const raw = (await s.get("index")) as SearchHit[] | undefined;
  if (!Array.isArray(raw)) return;
  const filtered = raw.filter((h) => h.sessionId !== sessionId);
  if (filtered.length !== raw.length) {
    await s.set("index", filtered);
  }
}

export async function indexMessage(
  sessionId: string,
  messageId: string,
  text: string,
): Promise<void> {
  await indexMessagesBatch(sessionId, [{ messageId, text }]);
}

export async function searchHistory(
  query: string,
  opts?: { limit?: number; sessionId?: string },
): Promise<SearchResult> {
  const s = await getStore();
  const raw = (await s.get("index")) as SearchHit[] | undefined;
  const entries: SearchHit[] = Array.isArray(raw) ? raw : [];

  const q = query.trim().toLowerCase();
  if (!q) return { hits: [], total: 0 };

  const limit = Math.min(opts?.limit ?? 20, 100);
  const scored = entries
    .map((hit) => {
      const hay = hit.text.toLowerCase();
      const score = hay.includes(q)
        ? hay.indexOf(q) === 0
          ? 100
          : 50
        : hay.split(q).length > 1
          ? 20
          : -1;
      return { ...hit, score };
    })
    .filter((h) => h.score >= 0)
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));

  const filtered = opts?.sessionId
    ? scored.filter((h) => h.sessionId === opts.sessionId)
    : scored;

  return {
    hits: filtered.slice(0, limit),
    total: filtered.length,
  };
}

export async function clearIndex(): Promise<void> {
  const s = await getStore();
  await s.set("index", []);
}
