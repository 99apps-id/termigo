import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkWritableCanonical } from "../lib/security";
import { useArtifactsStore } from "../store/artifactsStore";
import { useChatStore } from "../store/chatStore";
import { resolvePath, type ToolContext } from "./context";

export type ImageGenerationOutput = {
  ok: boolean;
  path: string;
  prompt: string;
  size?: string;
  mediaType: string;
  data: string;
  bytesWritten: number;
};

function isImageGenerationOutput(val: unknown): val is ImageGenerationOutput {
  return (
    Boolean(val) &&
    typeof val === "object" &&
    (val as Record<string, unknown>).ok === true &&
    typeof (val as Record<string, unknown>).data === "string" &&
    typeof (val as Record<string, unknown>).path === "string"
  );
}

/**
 * Aspect ratio to standard resolution mapping.
 */
function resolveDimensions(
  aspectRatio?: string,
  requestedSize?: string,
): { width: number; height: number; sizeStr: "1024x1024" | "1792x1024" | "1024x1792" } {
  if (requestedSize === "1792x1024" || requestedSize === "1024x1792" || requestedSize === "1024x1024") {
    const [w, h] = requestedSize.split("x").map(Number);
    return { width: w, height: h, sizeStr: requestedSize };
  }

  switch (aspectRatio) {
    case "16:9":
    case "3:2":
      return { width: 1792, height: 1024, sizeStr: "1792x1024" };
    case "9:16":
    case "2:3":
      return { width: 1024, height: 1792, sizeStr: "1024x1792" };
    case "1:1":
    default:
      return { width: 1024, height: 1024, sizeStr: "1024x1024" };
  }
}

export function buildImageGenerationTools(ctx: ToolContext) {
  return {
    generate_image: tool({
      description:
        "Generate a visual image artifact using AI image generation (DALL-E 3 / Imagen / OpenRouter) and save it persistently to the workspace. Specify detailed styling, composition, and constraints. Returns the local image path and thumbnail preview.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe(
            "Detailed image generation prompt describing subject, style, lighting, composition, and visual details.",
          ),
        aspect_ratio: z
          .enum(["1:1", "16:9", "9:16", "4:3", "3:2"])
          .optional()
          .describe("Output aspect ratio. Defaults to '1:1'."),
        size: z
          .enum(["1024x1024", "1792x1024", "1024x1792", "512x512"])
          .optional()
          .describe("Optional resolution hint."),
        output_path: z
          .string()
          .optional()
          .describe(
            "Target file path to save the image (e.g. 'assets/hero.png'). Defaults to '.termigo/generated/image_<timestamp>.png'.",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Image generation model to use. Defaults to 'dall-e-3'.",
          ),
      }),
      execute: async ({ prompt, aspect_ratio, size, output_path, model }) => {
        const { sizeStr } = resolveDimensions(aspect_ratio, size);
        const resolvedModel = model || "dall-e-3";

        // Determine target file path
        const now = Date.now();
        const defaultRel = `.termigo/generated/image_${now}.png`;
        const rawTarget = output_path && output_path.trim() ? output_path.trim() : defaultRel;
        const resolvedTarget = resolvePath(rawTarget, ctx.getCwd());

        const safety = await checkWritableCanonical(resolvedTarget, native.canonicalize);
        if (!safety.ok) {
          return { error: safety.reason, path: resolvedTarget };
        }
        const abs = safety.canonical;

        const apiKeys = useChatStore.getState().apiKeys;
        const openaiKey = apiKeys.openai?.trim();
        const openrouterKey = apiKeys.openrouter?.trim();
        const googleKey = apiKeys.google?.trim();

        let base64Data: string | null = null;
        let mediaType = "image/png";

        // 1. OpenAI DALL-E
        if (openaiKey) {
          try {
            const res = await fetch("https://api.openai.com/v1/images/generations", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${openaiKey}`,
              },
              body: JSON.stringify({
                model: resolvedModel,
                prompt,
                n: 1,
                size: sizeStr,
                response_format: "b64_json",
              }),
            });

            if (!res.ok) {
              const errBody = await res.text().catch(() => "");
              return {
                error: `OpenAI Image API error ${res.status}: ${errBody.slice(0, 300)}`,
                path: abs,
              };
            }

            const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
            const item = json.data?.[0];
            if (item?.b64_json) {
              base64Data = item.b64_json;
            } else if (item?.url) {
              // Fetch remote image if returned as URL
              const imgRes = await fetch(item.url);
              if (imgRes.ok) {
                const ab = await imgRes.arrayBuffer();
                base64Data = btoa(
                  new Uint8Array(ab).reduce((acc, byte) => acc + String.fromCharCode(byte), ""),
                );
              }
            }
          } catch (err) {
            return { error: `Image generation network error: ${String(err)}`, path: abs };
          }
        } else if (openrouterKey) {
          // 2. OpenRouter Image endpoint fallback
          try {
            const res = await fetch("https://openrouter.ai/api/v1/images/generations", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${openrouterKey}`,
              },
              body: JSON.stringify({
                prompt,
                model: model || "openai/gpt-5.4-image-2",
                response_format: "b64_json",
              }),
            });

            if (!res.ok) {
              const errBody = await res.text().catch(() => "");
              return {
                error: `OpenRouter Image API error ${res.status}: ${errBody.slice(0, 300)}`,
                path: abs,
              };
            }

            const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
            const item = json.data?.[0];
            if (item?.b64_json) {
              base64Data = item.b64_json;
            }
          } catch (err) {
            return { error: `OpenRouter image error: ${String(err)}`, path: abs };
          }
        } else if (googleKey) {
          // 3. Google Imagen endpoint
          try {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${googleKey}`;
            const res = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                instances: [{ prompt }],
                parameters: { sampleCount: 1, aspectRatio: aspect_ratio || "1:1" },
              }),
            });

            if (!res.ok) {
              const errBody = await res.text().catch(() => "");
              return {
                error: `Google Imagen API error ${res.status}: ${errBody.slice(0, 300)}`,
                path: abs,
              };
            }

            const json = (await res.json()) as {
              predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
            };
            const pred = json.predictions?.[0];
            if (pred?.bytesBase64Encoded) {
              base64Data = pred.bytesBase64Encoded;
              if (pred.mimeType) mediaType = pred.mimeType;
            }
          } catch (err) {
            return { error: `Google Imagen error: ${String(err)}`, path: abs };
          }
        } else {
          return {
            error:
              "No image generation provider configured. Please add an OpenAI, OpenRouter, or Google API key in Termigo Settings to generate images.",
            path: abs,
          };
        }

        if (!base64Data) {
          return { error: "Provider did not return image data", path: abs };
        }

        // Write binary file to disk
        try {
          await native.writeFileBase64(abs, base64Data);

          // Add to Artifacts panel
          useArtifactsStore.getState().add(ctx.getSessionId() ?? "", {
            kind: "file",
            title: abs.split(/[\\/]/).pop() || abs,
            payload: abs,
          });

          return {
            ok: true,
            path: abs,
            prompt,
            size: sizeStr,
            mediaType,
            data: base64Data,
            bytesWritten: Math.round((base64Data.length * 3) / 4),
          };
        } catch (err) {
          return { error: `Failed to save image to disk: ${String(err)}`, path: abs };
        }
      },
      toModelOutput: ({ output }) => {
        if (isImageGenerationOutput(output)) {
          return {
            type: "content",
            value: [
              {
                type: "text",
                text: `Generated image successfully saved to ${output.path} (${output.mediaType}, ${output.bytesWritten} bytes).`,
              },
              {
                type: "image-data",
                data: output.data,
                mediaType: output.mediaType,
              },
            ],
          };
        }
        return { type: "json", value: output as never };
      },
    }),
  };
}
