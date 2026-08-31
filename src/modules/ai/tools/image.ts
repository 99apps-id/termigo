// Reading an image for the agent.
//
// `read_file` already feeds images to a vision model, but a dedicated tool
// makes the intent explicit and skips the text-file pipeline (byte cap,
// sensitive-file checks are still respected via checkReadableCanonical). The
// result is handed to the model as a real `image-data` part, exactly like
// `browser_screenshot`, so a vision-capable model can see and describe it.

import { tool } from "ai";
import { z } from "zod";
import { modelSupportsVision } from "../config";
import { native } from "../lib/native";
import { checkReadableCanonical } from "../lib/security";
import { useChatStore } from "../store/chatStore";
import { resolvePath, type ToolContext } from "./context";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}

type ImageOutput = {
  path: string;
  kind: "image";
  mediaType: string;
  data: string;
  size: number;
};

export function buildImageTools(ctx: ToolContext) {
  return {
    read_image: tool({
      description:
        "Read an image file (png, jpg, gif, webp, bmp — local only) and SEE it: screenshot, mockup, diagram, chart, photo, or a rendered page. Use when the user points at an image, or to inspect a visual artifact on disk. Requires a vision-capable model; the image is returned as a picture, not as base64 text. Read-only, auto-executes.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (!isImagePath(abs)) {
          return { error: `not an image file: ${abs}`, path: abs };
        }
        const modelId = useChatStore.getState().selectedModelId;
        if (!modelSupportsVision(modelId)) {
          return {
            error:
              "the selected model has no vision capability, so it cannot see this image — switch to a vision-capable model, or use read_file for text files.",
            path: abs,
          };
        }
        try {
          const img = await native.readImageBase64(abs);
          return {
            path: abs,
            kind: "image" as const,
            mediaType: img.media_type,
            data: img.data,
            size: img.size,
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
      // Feed the image to the model as a real visual part.
      toModelOutput: ({ output }) => {
        const o = output as ImageOutput | null;
        if (o && o.kind === "image" && typeof o.data === "string") {
          return {
            type: "content",
            value: [
              {
                type: "text",
                text: `Image ${o.path} (${o.mediaType}, ${o.size} bytes)`,
              },
              { type: "image-data", data: o.data, mediaType: o.mediaType },
            ],
          };
        }
        return { type: "json", value: output as never };
      },
    }),
  } as const;
}
