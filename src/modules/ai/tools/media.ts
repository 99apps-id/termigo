import { useTelegramStore } from "@/modules/telegram/store";
import { sendPhotoBytes, sendVoice } from "@/modules/telegram/telegramApi";
import { tool } from "ai";
import { z } from "zod";
import { getKey } from "../lib/keyring";
import { native } from "../lib/native";
import { base64ToBytes, createProxyFetch } from "../lib/proxyFetch";
import {
  checkReadableCanonical,
  checkWritableCanonical,
} from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

const proxyFetch = createProxyFetch();

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function sanitizeLang(lang: string): string {
  const clean = lang.replace(/[^a-zA-Z0-9_+]/g, "");
  return clean || "eng";
}

function defaultOutputPath(cwd: string, prefix: string, ext: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}/.termigo/generated/${prefix}-${stamp}.${ext}`;
}

export function buildMediaTools(ctx: ToolContext) {
  return {
    ocr_extract: tool({
      description:
        "Extract text from an image (.png, .jpg, .webp, .bmp, .tiff) or a scanned PDF (.pdf) using OCR (tesseract, plus pdftoppm for PDF pages). Use this when read_pdf returns no text layer or when extracting text from screenshots/scans.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Relative or absolute path to the image or PDF file."),
        lang: z
          .string()
          .optional()
          .describe(
            "Tesseract language pack(s), e.g. 'eng', 'ind', or 'eng+ind'. Defaults to 'eng'.",
          ),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum PDF pages to OCR (default 5, max 20)."),
      }),
      execute: async ({ path, lang, max_pages }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) {
          return { ok: false, error: safety.reason, path: reqPath };
        }
        const abs = safety.canonical;
        const tesseractLang = sanitizeLang(lang ?? "eng");
        const isPdf = abs.toLowerCase().endsWith(".pdf");
        const maxPages = max_pages ?? 5;

        const cmd = isPdf
          ? [
              `if ! command -v tesseract >/dev/null 2>&1; then echo "__NO_TESSERACT__"; exit 2; fi`,
              `if ! command -v pdftoppm >/dev/null 2>&1; then echo "__NO_PDFTOPPM__"; exit 3; fi`,
              `TMPDIR=$(mktemp -d)`,
              `trap 'rm -rf "$TMPDIR"' EXIT`,
              `pdftoppm -png -f 1 -l ${maxPages} ${shellQuote(abs)} "$TMPDIR/page"`,
              `for img in "$TMPDIR"/page-*.png; do`,
              `  [ -e "$img" ] || continue`,
              `  echo "--- PAGE $(basename "$img") ---"`,
              `  tesseract "$img" stdout -l ${shellQuote(tesseractLang)} 2>/dev/null || tesseract "$img" stdout -l eng 2>/dev/null`,
              `done`,
            ].join("\n")
          : [
              `if ! command -v tesseract >/dev/null 2>&1; then echo "__NO_TESSERACT__"; exit 2; fi`,
              `tesseract ${shellQuote(abs)} stdout -l ${shellQuote(tesseractLang)} 2>/dev/null || tesseract ${shellQuote(abs)} stdout -l eng 2>/dev/null`,
            ].join("\n");

        try {
          const res = await native.runCommand(cmd, ctx.getCwd(), 90);
          const out = (res.stdout ?? "").trim();
          if (out.includes("__NO_TESSERACT__")) {
            return {
              ok: false,
              path: abs,
              error:
                "tesseract is not installed on this machine. Install it (e.g. `sudo apt install tesseract-ocr tesseract-ocr-ind poppler-utils` or `brew install tesseract poppler`). For images, you can also call `read_image` directly.",
            };
          }
          if (out.includes("__NO_PDFTOPPM__")) {
            return {
              ok: false,
              path: abs,
              error:
                "pdftoppm (poppler-utils) is required to rasterize PDF pages for OCR. Install it via `sudo apt install poppler-utils` or `brew install poppler`.",
            };
          }
          if (res.exit_code !== 0 && !out) {
            return {
              ok: false,
              path: abs,
              error:
                (res.stderr ?? "").trim() ||
                `OCR failed with exit code ${res.exit_code}`,
            };
          }
          const truncated = out.length > 60_000;
          return {
            ok: true,
            path: abs,
            lang: tesseractLang,
            truncated,
            text: truncated ? out.slice(0, 60_000) : out,
          };
        } catch (e) {
          return {
            ok: false,
            path: abs,
            error: `OCR execution failed: ${String(e)}`,
          };
        }
      },
    }),

    generate_image: tool({
      description:
        "Generate an image from a text prompt using the user's configured OpenAI (gpt-image-1 / dall-e-3) or Google Gemini image model, save it to the workspace, and optionally send it directly to the paired Telegram chat.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe("Detailed description of the image to generate."),
        output_path: z
          .string()
          .optional()
          .describe(
            "Optional workspace path to save the generated PNG (defaults to .termigo/generated/image-<ts>.png).",
          ),
        size: z
          .enum(["1024x1024", "1536x1024", "1024x1536"])
          .optional()
          .describe("Image dimensions (default 1024x1024)."),
        provider: z
          .enum(["auto", "openai", "google"])
          .optional()
          .describe("Image provider preference (default auto)."),
        send_to_telegram: z
          .boolean()
          .optional()
          .describe(
            "When true, also send the generated image directly to the paired Telegram chat.",
          ),
        caption: z
          .string()
          .optional()
          .describe("Optional caption when sending to Telegram."),
      }),
      execute: async ({
        prompt,
        output_path,
        size,
        provider,
        send_to_telegram,
        caption,
      }) => {
        const pref = provider ?? "auto";
        const openaiKey =
          pref === "auto" || pref === "openai" ? await getKey("openai") : null;
        const googleKey =
          pref === "auto" || pref === "google" ? await getKey("google") : null;

        let imageBytes: Uint8Array | null = null;
        let usedProvider = "";
        let mimeType = "image/png";
        const errors: string[] = [];

        if (openaiKey && (pref === "openai" || pref === "auto")) {
          try {
            const res = await proxyFetch(
              "https://api.openai.com/v1/images/generations",
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${openaiKey}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  model: "gpt-image-1",
                  prompt,
                  size: size ?? "1024x1024",
                  n: 1,
                }),
              },
            );
            if (!res.ok) {
              const errText = await res.text().catch(() => res.statusText);
              errors.push(`OpenAI (${res.status}): ${errText.slice(0, 200)}`);
            } else {
              const json = (await res.json()) as {
                data?: Array<{ b64_json?: string; url?: string }>;
              };
              const first = json.data?.[0];
              if (first?.b64_json) {
                imageBytes = base64ToBytes(first.b64_json);
                usedProvider = "openai/gpt-image-1";
              } else if (first?.url) {
                const imgRes = await proxyFetch(first.url);
                if (imgRes.ok) {
                  imageBytes = new Uint8Array(await imgRes.arrayBuffer());
                  usedProvider = "openai/gpt-image-1";
                }
              }
            }
          } catch (e) {
            errors.push(`OpenAI error: ${String(e)}`);
          }
        }

        if (
          !imageBytes &&
          googleKey &&
          (pref === "google" || pref === "auto")
        ) {
          try {
            const res = await proxyFetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(googleKey)}`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: { responseModalities: ["IMAGE"] },
                }),
              },
            );
            if (!res.ok) {
              const errText = await res.text().catch(() => res.statusText);
              errors.push(`Google (${res.status}): ${errText.slice(0, 200)}`);
            } else {
              const json = (await res.json()) as {
                candidates?: Array<{
                  content?: {
                    parts?: Array<{
                      inlineData?: { data?: string; mimeType?: string };
                    }>;
                  };
                }>;
              };
              const part = json.candidates?.[0]?.content?.parts?.find(
                (p) => p.inlineData?.data,
              );
              if (part?.inlineData?.data) {
                imageBytes = base64ToBytes(part.inlineData.data);
                mimeType = part.inlineData.mimeType || "image/png";
                usedProvider = "google/gemini-2.5-flash-image";
              }
            }
          } catch (e) {
            errors.push(`Google error: ${String(e)}`);
          }
        }

        if (!imageBytes) {
          return {
            ok: false,
            error:
              errors.length > 0
                ? `Image generation failed: ${errors.join("; ")}`
                : "No OpenAI or Google API key is configured for image generation. Add an OpenAI or Google Gemini API key in Settings.",
          };
        }

        const cwd = ctx.getCwd() ?? ".";
        const ext = mimeType.includes("jpeg") ? "jpg" : "png";
        const target = output_path
          ? resolvePath(output_path, cwd)
          : defaultOutputPath(cwd, "image", ext);
        const safety = await checkWritableCanonical(
          target,
          native.canonicalize,
        );
        if (!safety.ok) {
          return { ok: false, error: safety.reason, path: target };
        }

        await native.writeFileBase64(
          safety.canonical,
          bytesToBase64(imageBytes),
        );

        let sentToTelegram = false;
        let telegramError: string | undefined;
        if (send_to_telegram) {
          const store = useTelegramStore.getState();
          const targetChatId = store.chatId ?? store.ownerUserId;
          if (targetChatId) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            try {
              const name =
                safety.canonical.split(/[\\/]/).pop() || `image.${ext}`;
              await sendPhotoBytes(
                targetChatId,
                imageBytes,
                name,
                mimeType,
                caption ?? "",
                controller.signal,
              );
              sentToTelegram = true;
            } catch (e) {
              telegramError = String(e);
            } finally {
              clearTimeout(timer);
            }
          } else {
            telegramError = "Telegram is not paired";
          }
        }

        return {
          ok: true,
          path: safety.canonical,
          provider: usedProvider,
          bytes: imageBytes.byteLength,
          sentToTelegram,
          ...(telegramError ? { telegramError } : {}),
        };
      },
    }),

    text_to_speech: tool({
      description:
        "Synthesize spoken audio (TTS / voice note) from text using OpenAI TTS (gpt-4o-mini-tts) or local system TTS (edge-tts / espeak-ng), save to the workspace, and optionally send it directly as a Telegram voice note.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(4096)
          .describe("Text to convert to speech."),
        voice: z
          .string()
          .optional()
          .describe(
            "Voice name (OpenAI: alloy, ash, coral, echo, nova, onyx, sage, shimmer; default 'nova').",
          ),
        format: z
          .enum(["opus", "mp3", "wav"])
          .optional()
          .describe(
            "Audio format ('opus' produces .ogg for Telegram voice notes; default 'opus').",
          ),
        output_path: z
          .string()
          .optional()
          .describe(
            "Optional workspace path to save the audio file (defaults to .termigo/generated/voice-<ts>.ogg).",
          ),
        send_to_telegram: z
          .boolean()
          .optional()
          .describe(
            "When true, immediately send the synthesized audio as a Telegram voice note to the paired chat.",
          ),
        caption: z
          .string()
          .optional()
          .describe("Optional caption when sending to Telegram."),
      }),
      execute: async ({
        text,
        voice,
        format,
        output_path,
        send_to_telegram,
        caption,
      }) => {
        const fmt = format ?? "opus";
        const ext = fmt === "opus" ? "ogg" : fmt;
        const mime =
          fmt === "opus"
            ? "audio/ogg"
            : fmt === "mp3"
              ? "audio/mpeg"
              : "audio/wav";
        const chosenVoice = voice ?? "nova";
        const openaiKey = await getKey("openai");

        let audioBytes: Uint8Array | null = null;
        let usedProvider = "";
        let finalExt = ext;
        let finalMime = mime;
        const errors: string[] = [];

        if (openaiKey) {
          try {
            const res = await proxyFetch(
              "https://api.openai.com/v1/audio/speech",
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${openaiKey}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  model: "gpt-4o-mini-tts",
                  input: text,
                  voice: chosenVoice,
                  response_format: fmt,
                }),
              },
            );
            if (!res.ok) {
              const errText = await res.text().catch(() => res.statusText);
              errors.push(
                `OpenAI TTS (${res.status}): ${errText.slice(0, 200)}`,
              );
            } else {
              audioBytes = new Uint8Array(await res.arrayBuffer());
              usedProvider = "openai/gpt-4o-mini-tts";
            }
          } catch (e) {
            errors.push(`OpenAI TTS error: ${String(e)}`);
          }
        }

        const cwd = ctx.getCwd() ?? ".";
        const target = output_path
          ? resolvePath(output_path, cwd)
          : defaultOutputPath(cwd, "voice", finalExt);
        const safety = await checkWritableCanonical(
          target,
          native.canonicalize,
        );
        if (!safety.ok) {
          return { ok: false, error: safety.reason, path: target };
        }

        // Local fallback via edge-tts or espeak-ng when no OpenAI key is set.
        if (!audioBytes) {
          const outPath = safety.canonical;
          const cmd = [
            `mkdir -p ${shellQuote(outPath.replace(/[\\/][^\\/]+$/, ""))}`,
            `if command -v edge-tts >/dev/null 2>&1; then`,
            `  edge-tts --text ${shellQuote(text)} --write-media ${shellQuote(outPath)} && echo "__USED_EDGE_TTS__"`,
            `elif command -v espeak-ng >/dev/null 2>&1; then`,
            `  espeak-ng -w ${shellQuote(outPath)} ${shellQuote(text)} && echo "__USED_ESPEAK__"`,
            `else`,
            `  echo "__NO_LOCAL_TTS__"`,
            `  exit 2`,
            `fi`,
          ].join("\n");
          const localRes = await native.runCommand(cmd, ctx.getCwd(), 60);
          const stdout = localRes.stdout ?? "";
          if (stdout.includes("__USED_EDGE_TTS__")) {
            usedProvider = "local/edge-tts";
            finalExt = "mp3";
            finalMime = "audio/mpeg";
            const readBack = await native.readFileBase64(outPath);
            audioBytes = base64ToBytes(readBack.data);
          } else if (stdout.includes("__USED_ESPEAK__")) {
            usedProvider = "local/espeak-ng";
            finalExt = "wav";
            finalMime = "audio/wav";
            const readBack = await native.readFileBase64(outPath);
            audioBytes = base64ToBytes(readBack.data);
          } else {
            return {
              ok: false,
              error:
                errors.length > 0
                  ? `TTS failed: ${errors.join("; ")}`
                  : "No OpenAI API key configured and neither edge-tts nor espeak-ng is installed locally.",
            };
          }
        } else {
          await native.writeFileBase64(
            safety.canonical,
            bytesToBase64(audioBytes),
          );
        }

        let sentToTelegram = false;
        let telegramError: string | undefined;
        if (send_to_telegram && audioBytes) {
          const store = useTelegramStore.getState();
          const targetChatId = store.chatId ?? store.ownerUserId;
          if (targetChatId) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            try {
              const name =
                safety.canonical.split(/[\\/]/).pop() || `voice.${finalExt}`;
              await sendVoice(
                targetChatId,
                audioBytes,
                name,
                finalMime,
                caption ?? "",
                controller.signal,
              );
              sentToTelegram = true;
            } catch (e) {
              telegramError = String(e);
            } finally {
              clearTimeout(timer);
            }
          } else {
            telegramError = "Telegram is not paired";
          }
        }

        return {
          ok: true,
          path: safety.canonical,
          provider: usedProvider,
          bytes: audioBytes.byteLength,
          sentToTelegram,
          ...(telegramError ? { telegramError } : {}),
        };
      },
    }),
  };
}
