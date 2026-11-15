// Office document generation and reading, backed by the pure-Rust writers in
// `src-tauri/src/modules/office.rs`. Every format here is an OOXML/zip
// container the model cannot author by hand in a chat turn, so the tools take
// structured blocks and let Rust emit well-formed parts. No external runtime
// (no LibreOffice, no Python) is invoked, which keeps the app self-contained on
// a machine that only installed the app.

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { resolvePath, type ToolContext } from "./context";

// Keep generated output small: a runaway table would produce a workbook the
// UI preview cannot render and a document nobody reads.
const MAX_ROWS = 5000;
const MAX_COLS = 200;
const MAX_BLOCKS = 2000;

const node = z
  .string()
  .describe("Absolute path, or relative to the active terminal cwd.");

const blockSchema = z.object({
  kind: z
    .enum(["heading", "paragraph", "bullets"])
    .optional()
    .describe(
      "Block type. Default 'paragraph'. 'heading' uses level 1-6; 'bullets' renders one bullet per entry in bullets.",
    ),
  text: z
    .string()
    .optional()
    .describe("Paragraph or heading text. Ignored for 'bullets'."),
  bullets: z
    .array(z.string())
    .optional()
    .describe("Bullet lines. Used only when kind is 'bullets'."),
  level: z
    .number()
    .int()
    .min(0)
    .max(8)
    .optional()
    .describe("Heading level (1-6) or bullet indent (0-8)."),
});

type Block = z.infer<typeof blockSchema>;

const slideSchema = z.object({
  title: z.string().optional().describe("Slide title. Defaults to text."),
  text: z.string().optional().describe("Fallback slide title."),
  body: z
    .string()
    .optional()
    .describe("Single body paragraph under the title."),
  bullets: z
    .array(z.string())
    .optional()
    .describe("Bullet lines for the slide body."),
});

type Slide = z.infer<typeof slideSchema>;

function clampBlocks<T>(blocks: T[], what: string): T[] | { error: string } {
  if (blocks.length > MAX_BLOCKS) {
    return {
      error: `${blocks.length} ${what} exceeds the ${MAX_BLOCKS} per-call limit; split the document into several writes (append is not supported, so write the full set in one call under the limit).`,
    };
  }
  return blocks;
}

export function buildOfficeTools(ctx: ToolContext) {
  const fail = (e: unknown, path: string) => ({
    error: String(e),
    path,
  });

  return {
    excel_write: tool({
      description:
        "Create an .xlsx workbook. Pass sheets as [{ name, rows }] where rows is a row-major array of arrays; strings become text cells and numbers become numeric cells so the sheet stays computable in Excel. Use for spreadsheets, data exports and budget/table reports. Writes the whole file: an existing file at the same path is replaced. Not read-only, so it follows the write approval policy.",
      inputSchema: z.object({
        path: node,
        sheets: z
          .array(
            z.object({
              name: z
                .string()
                .optional()
                .describe("Sheet name. Defaults to Sheet1, Sheet2, ..."),
              rows: z
                .array(
                  z.array(
                    z.union([z.string(), z.number(), z.boolean(), z.null()]),
                  ),
                )
                .describe("Row-major cells. The first row is usually headers."),
            }),
          )
          .min(1)
          .describe("One or more sheets, written in order."),
      }),
      execute: async ({ path, sheets }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        for (const sheet of sheets) {
          if (sheet.rows.length > MAX_ROWS) {
            return {
              error: `sheet "${sheet.name ?? "Sheet1"}" has ${sheet.rows.length} rows, above the ${MAX_ROWS} limit`,
              path: reqPath,
            };
          }
          for (const row of sheet.rows) {
            if (row.length > MAX_COLS) {
              return {
                error: `a row has ${row.length} cells, above the ${MAX_COLS} limit`,
                path: reqPath,
              };
            }
          }
        }
        try {
          return await native.officeXlsxWrite(reqPath, sheets);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    excel_read: tool({
      description:
        "Read an .xlsx workbook: sheet names plus the cell values of one sheet as rows. Use sheet to pick a sheet other than the first. Read-only, auto-executes.",
      inputSchema: z.object({
        path: node,
        sheet: z
          .string()
          .optional()
          .describe("Sheet name to read. Defaults to the first sheet."),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROWS)
          .optional()
          .describe("Stop after this many rows. Default 200."),
        max_cols: z
          .number()
          .int()
          .min(1)
          .max(MAX_COLS)
          .optional()
          .describe("Stop after this many columns per row. Default 50."),
      }),
      execute: async ({ path, sheet, max_rows, max_cols }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        try {
          return await native.officeXlsxRead(
            reqPath,
            sheet,
            max_rows ?? 200,
            max_cols ?? 50,
          );
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    docx_create: tool({
      description:
        "Create a .docx Word document from structured blocks (title, headings, paragraphs, bullet lists). Use for letters, reports, specs and any prose deliverable the user will open in Word. Writes the whole file: an existing file at the same path is replaced. Not read-only, so it follows the write approval policy.",
      inputSchema: z.object({
        path: node,
        title: z
          .string()
          .optional()
          .describe("Document title, rendered as the top Title paragraph."),
        blocks: z
          .array(blockSchema)
          .describe("Document body, rendered in order."),
      }),
      execute: async ({ path, title, blocks }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const guarded = clampBlocks(blocks as Block[], "blocks");
        if (!Array.isArray(guarded)) return { ...guarded, path: reqPath };
        try {
          return await native.officeDocxWrite(reqPath, title, guarded);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    docx_read: tool({
      description:
        "Extract the text of a .docx Word document, in document order, up to 30KB. Use to read a report, contract, or spec the user references. Read-only, auto-executes.",
      inputSchema: z.object({
        path: node,
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(200000)
          .optional()
          .describe("Stop after this many characters. Default 30000."),
      }),
      execute: async ({ path, max_chars }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        try {
          return await native.officeDocxRead(reqPath, max_chars ?? 30000);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    pptx_create: tool({
      description:
        "Create a .pptx presentation. Pass slides as [{ title, body, bullets }]; one deck slide per entry, in order. Use for pitch decks, reviews and training slides. Writes the whole file: an existing file at the same path is replaced. Not read-only, so it follows the write approval policy.",
      inputSchema: z.object({
        path: node,
        slides: z
          .array(slideSchema)
          .min(1)
          .describe("Slides, rendered in order."),
      }),
      execute: async ({ path, slides }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const guarded = clampBlocks(slides as Slide[], "slides");
        if (!Array.isArray(guarded)) return { ...guarded, path: reqPath };
        try {
          return await native.officePptxWrite(reqPath, guarded);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    pptx_read: tool({
      description:
        "Extract the text of a .pptx presentation slide by slide, up to 30KB. Read-only, auto-executes.",
      inputSchema: z.object({
        path: node,
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(200000)
          .optional()
          .describe("Stop after this many characters. Default 30000."),
      }),
      execute: async ({ path, max_chars }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        try {
          return await native.officePptxRead(reqPath, max_chars ?? 30000);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    pdf_create: tool({
      description:
        "Create a text .pdf from the same block structure as docx_create, paginated automatically. Use when the deliverable must be a PDF and the content is text (reports, invoices, letters). For a PDF built from an existing HTML or Markdown file, render that instead. Writes the whole file: an existing file at the same path is replaced. Not read-only, so it follows the write approval policy.",
      inputSchema: z.object({
        path: node,
        title: z.string().optional().describe("Document title."),
        blocks: z
          .array(blockSchema)
          .describe("Document body, rendered in order."),
      }),
      execute: async ({ path, title, blocks }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const guarded = clampBlocks(blocks as Block[], "blocks");
        if (!Array.isArray(guarded)) return { ...guarded, path: reqPath };
        try {
          return await native.officePdfWrite(reqPath, title, guarded);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    csv_write: tool({
      description:
        "Write a .csv from a row-major array of arrays. Use for data exports and anything a spreadsheet or script will read back. Writes the whole file: an existing file at the same path is replaced. Not read-only, so it follows the write approval policy.",
      inputSchema: z.object({
        path: node,
        rows: z
          .array(
            z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
          )
          .min(1)
          .describe("Row-major cells. The first row is usually headers."),
        delimiter: z
          .string()
          .length(1)
          .optional()
          .describe("Field delimiter. Default ','."),
      }),
      execute: async ({ path, rows, delimiter }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        if (rows.length > MAX_ROWS) {
          return {
            error: `${rows.length} rows, above the ${MAX_ROWS} limit`,
            path: reqPath,
          };
        }
        try {
          return await native.officeCsvWrite(reqPath, rows, delimiter);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    csv_analyze: tool({
      description:
        "Read a .csv and return its header, row count and a preview of the rows. Use to inspect a data file before transforming it, instead of reading the whole file into context. Read-only, auto-executes.",
      inputSchema: z.object({
        path: node,
        delimiter: z
          .string()
          .length(1)
          .optional()
          .describe("Field delimiter. Default ','."),
        has_header: z
          .boolean()
          .optional()
          .describe("Treat the first row as a header. Default true."),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROWS)
          .optional()
          .describe("Preview this many rows. Default 50."),
      }),
      execute: async ({ path, delimiter, has_header, max_rows }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        try {
          return await native.officeCsvRead(
            reqPath,
            delimiter,
            has_header ?? true,
            max_rows ?? 50,
          );
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    calendar_write: tool({
      description:
        "Create an .ics calendar file with one or more events, importable into Outlook, Google Calendar and Apple Calendar. Timestamps are iCalendar form: a date '20250131' or a UTC date-time '20250131T140000Z'. Use for invites, schedules and reminders. Writes the whole file: an existing file at the same path is replaced. Not read-only, so it follows the write approval policy.",
      inputSchema: z.object({
        path: node,
        events: z
          .array(
            z.object({
              summary: z.string().describe("Event title."),
              start: z
                .string()
                .describe("Start: '20250131' or '20250131T140000Z'."),
              end: z
                .string()
                .optional()
                .describe(
                  "End, same format as start. Defaults to a 1-hour event.",
                ),
              description: z.string().optional().describe("Event details."),
              location: z.string().optional().describe("Event location."),
            }),
          )
          .min(1)
          .describe("Events, written in order."),
      }),
      execute: async ({ path, events }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        try {
          return await native.officeIcsWrite(reqPath, events);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),

    calendar_read_ics: tool({
      description:
        "Read an .ics calendar file and return its events (summary, start, end, location). Use to inspect a schedule or check for conflicts. Read-only, auto-executes.",
      inputSchema: z.object({
        path: node,
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        try {
          return await native.officeIcsRead(reqPath);
        } catch (e) {
          return fail(e, reqPath);
        }
      },
    }),
  } as const;
}
