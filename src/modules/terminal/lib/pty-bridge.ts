import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { PtyOutputReceiver } from "./PtyOutputReceiver";

const textEncoder = new TextEncoder();

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  shell?: string,
  paneId?: number,
  persist?: boolean,
  persistKey?: string,
): Promise<PtySession> {
  // Raw bytes - no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  // Output credit. The backend holds back once a window of chunks is
  // unacknowledged, so each consumed chunk is acknowledged by its cumulative
  // byte mark, which releases the window. `id` is only known once `pty_open`
  // resolves; a chunk that beats it is still counted, so the mark catches up.
  const receiver = new PtyOutputReceiver();
  let id = 0;
  const acknowledge = () => {
    if (id === 0) return;
    void invoke("pty_ack_output", { id, bytes: receiver.bytesConsumed }).catch(
      () => {},
    );
  };

  onData.onmessage = (buf) => {
    const bytes = new Uint8Array(buf);
    receiver.consume(bytes.length);
    handlers.onData(bytes);
    acknowledge();
  };
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    blocks: blocks ?? false,
    shell: shell ?? null,
    paneId: paneId ?? null,
    persist: persist ?? false,
    persistKey: persistKey ?? null,
    onData,
    onExit,
  });

  // Chunks that arrived before `id` resolved are already counted; acknowledge
  // once so the backend's window re-opens without waiting for the next chunk.
  acknowledge();

  let closed = false;
  const headers = { "x-pty-id": String(id) };

  return {
    id,
    // Raw bytes + id header: no JSON round-trip on the per-keystroke path.
    write: (data) => invoke("pty_write", textEncoder.encode(data), { headers }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      releaseHandlers();
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
