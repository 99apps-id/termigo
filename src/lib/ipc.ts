// Canonical TypeScript mirrors of the Rust IPC payload enums used by the SSH
// module. Defined ONCE and imported everywhere so the shapes cannot silently
// diverge from src-tauri/src/modules/fs/file.rs.

/** Mirrors Rust `fs::file::ReadResult` (commands: fs_read_file, ...). */
export type FsReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/** Mirrors Rust `fs::file::ReadPortionResult`. No image variant. */
export type FsReadPortionResult =
  | {
      kind: "text";
      content: string;
      size: number;
      totalLines: number;
      startLine: number;
      endLine: number;
    }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };
