import { tool } from "ai";
import { z } from "zod";
import { clearIndex, searchHistory } from "../lib/fts5";

export type SearchHit = {
  sessionId: string;
  messageId: string;
  text: string;
};

export type SearchResult = {
  hits: SearchHit[];
  total: number;
};

export function buildSearchHistoryTools() {
  return {
    search_history: tool({
      description:
        "Search across your Termigo chat history using the local search index.",
      inputSchema: z.object({
        query: z.string().min(1).describe("The search query."),
        limit: z.number().int().min(1).max(100).optional().default(20),
        sessionId: z.string().optional().describe("Restrict to one session."),
      }),
      execute: async ({ query, limit, sessionId }) => {
        const result = await searchHistory(query, { limit, sessionId });
        if (!result.hits.length) {
          return {
            ok: true,
            query,
            total: 0,
            hits: [],
            message: "No history matches found.",
          };
        }
        return {
          ok: true,
          query,
          total: result.total,
          hits: result.hits.map((h) => ({
            sessionId: h.sessionId,
            messageId: h.messageId,
            text: h.text,
          })),
        };
      },
    }),
    clear_history_index: tool({
      description: "Clear the local Termigo search history index.",
      inputSchema: z.object({}),
      execute: async () => {
        await clearIndex();
        return {
          ok: true,
          message: "Search history index cleared.",
        };
      },
    }),
  };
}
