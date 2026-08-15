import type { ProviderKeys } from "./keyring";
import { createProxyFetch, proxyFetch } from "./proxyFetch";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const STT_TIMEOUT_GROQ_MS = 30_000;
const STT_TIMEOUT_WHISPERCPP_MS = 180_000;

// Transcription goes through the Rust HTTP proxy, like every other AI call.
// A direct browser fetch to api.openai.com / api.groq.com is cross-origin and
// those APIs send no CORS headers for a webview origin, so it fails with a bare
// "Failed to fetch" that names neither the host nor the reason.
const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });

/**
 * Encode one file field plus text fields as multipart/form-data.
 *
 * Built by hand rather than with FormData because the proxy forwards a byte
 * body and a header map: the browser only attaches the `boundary` parameter
 * when it serializes a FormData itself, so a FormData sent this way would
 * arrive without a parsable Content-Type.
 */
function multipartBody(
  file: { field: string; filename: string; type: string; bytes: Uint8Array },
  fields: Record<string, string>,
): { body: Blob; contentType: string } {
  const boundary = `----termigo${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
        `filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
  );
  parts.push(file.bytes);
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  return {
    body: new Blob(parts as BlobPart[]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
  transport: typeof fetch = proxyFetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await transport(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeOpenAI(blob: Blob, apiKey: string): Promise<string> {
  const [{ createOpenAI }, { experimental_transcribe: transcribe }] =
    await Promise.all([import("@ai-sdk/openai"), import("ai")]);
  const openai = createOpenAI({ apiKey, fetch: proxyFetch });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const { text } = await transcribe({
    model: openai.transcription("whisper-1"),
    audio: buf,
  });
  return text;
}

async function transcribeViaRest(
  baseURL: string,
  blob: Blob,
  apiKey: string | null,
  model: string,
): Promise<string> {
  const { body, contentType } = multipartBody(
    {
      field: "file",
      filename: "audio.webm",
      type: blob.type || "audio/webm",
      bytes: new Uint8Array(await blob.arrayBuffer()),
    },
    { model, response_format: "text" },
  );

  const headers: Record<string, string> = { "Content-Type": contentType };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetchWithTimeout(`${baseURL}/audio/transcriptions`, {
    method: "POST",
    headers,
    body,
  }, STT_TIMEOUT_GROQ_MS);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `STT request failed (${res.status}): ${body || res.statusText}`,
    );
  }
  return res.text();
}

async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const length = buf.length;
    const sampleRate = buf.sampleRate;
    const channel = buf.getChannelData(0);
    const dataLen = length * 2;
    const buffer = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buffer);

    const writeStr = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataLen, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataLen, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    return new Blob([buffer], { type: "audio/wav" });
  } finally {
    ctx.close();
  }
}

async function transcribeWhisperCpp(
  baseURL: string,
  blob: Blob,
): Promise<string> {
  const wav = await toWav(blob);
  const { body, contentType } = multipartBody(
    {
      field: "file",
      filename: "audio.wav",
      type: "audio/wav",
      bytes: new Uint8Array(await wav.arrayBuffer()),
    },
    { response_format: "text" },
  );

  // whisper.cpp is loopback-only (see assertLoopbackUrl), so this transport is
  // the one allowed to reach a private address.
  const res = await fetchWithTimeout(`${baseURL}/inference`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  }, STT_TIMEOUT_WHISPERCPP_MS, localProxyFetch);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `STT request failed (${res.status}): ${body || res.statusText}`,
    );
  }
  return res.text();
}

// Offline provider: never POST recorded audio to a non-loopback host.
function assertLoopbackUrl(baseURL: string): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error(`Invalid Whisper.cpp URL: ${baseURL}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  if (!loopback) {
    throw new Error(
      "Whisper.cpp must run on a loopback address (localhost or 127.x.x.x) to keep transcription local.",
    );
  }
}

export type SttOptions = {
  groqSttModel?: string;
  whispercppBaseURL?: string;
};

export async function transcribeAudio(
  blob: Blob,
  provider: import("../config").SttProvider,
  apiKeys: ProviderKeys,
  options: SttOptions = {},
): Promise<string> {
  switch (provider) {
    case "openai": {
      const key = apiKeys.openai;
      if (!key) throw new Error("OpenAI API key is not configured");
      return transcribeOpenAI(blob, key);
    }
    case "groq": {
      const key = apiKeys.groq;
      if (!key) throw new Error("Groq API key is not configured");
      const model = options.groqSttModel || "whisper-large-v3-turbo";
      return transcribeViaRest(GROQ_BASE_URL, blob, key, model);
    }
    case "whispercpp": {
      const baseURL =
        options.whispercppBaseURL?.replace(/\/+$/, "") || "http://127.0.0.1:8080";
      assertLoopbackUrl(baseURL);
      return transcribeWhisperCpp(baseURL, blob);
    }
  }
}
