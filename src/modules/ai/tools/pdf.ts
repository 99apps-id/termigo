// Reading PDF text for the agent.
//
// PDFs are binary, so they go through `fs_read_file_base64` (the same reader
// the report-sharing path uses), then the lightweight parser in
// `lib/pdfText.ts` extracts the text of every content stream. No heavy PDF
// dependency is added to the client bundle; the parser handles FlateDecode
// (the default for virtually every producer) and uncompressed streams, and
// degrades gracefully to "no text" for scanned/image-only PDFs.

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { extractPdfPages } from "../lib/pdfText";
import { checkReadableCanonical } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

const PDF_TEXT_CAP = 30 * 1024;

export function buildPdfTools(ctx: ToolContext) {
  return {
    read_pdf: tool({
      description:
        "Extract the text of a PDF file (local only): every page's readable text, in order, up to 30KB. Use to read a report, spec, or document the user references. Scanned (image-only) PDFs return no text — tell the user they need OCR, or describe pages visually if they can render them. Read-only, auto-executes.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Stop after this many pages. Default 60. Set lower for a quick skim of a long document.",
          ),
      }),
      execute: async ({ path, max_pages }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        let base64: { data: string; size: number; media_type: string };
        try {
          base64 = await native.readFileBase64(abs);
        } catch (e) {
          return { error: String(e), path: abs };
        }
        if (base64.media_type !== "application/pdf") {
          return {
            error: `file is ${base64.media_type || "not a PDF"}, not a PDF`,
            path: abs,
          };
        }
        const bytes = base64ToBytes(base64.data);
        let pages: string[];
        try {
          pages = await extractPdfPages(bytes);
        } catch (e) {
          return { error: String(e), path: abs };
        }
        const cap = max_pages ?? 60;
        const kept = pages.slice(0, cap);
        const text = kept.join("\n\n").trim();
        if (!text) {
          return {
            path: abs,
            pages: pages.length,
            text: "",
            note: "No extractable text — this PDF is likely scanned or image-only and needs OCR.",
          };
        }
        const capped =
          text.length > PDF_TEXT_CAP
            ? `${text.slice(0, PDF_TEXT_CAP)}\n… [truncated ${text.length - PDF_TEXT_CAP} chars]`
            : text;
        return {
          path: abs,
          pages: kept.length,
          total_pages: pages.length,
          truncated: pages.length > kept.length,
          text: capped,
        };
      },
    }),
  } as const;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
