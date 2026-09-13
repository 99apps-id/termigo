// Whether a language server failed because its executable could not be run.
//
// The distinction matters because the fix differs and the app already knows it:
// a preset that documents an install command can offer it, while a server that
// died for another reason - a memory budget, a panic on a large crate - must not
// be answered with "install it", which sends the user down the wrong path.
//
// The case this exists for is specific and easy to miss: rustup installs a
// `rust-analyzer.exe` shim into `~/.cargo/bin`, so the binary IS on PATH and
// every existence check in the app passes. The shim then fails at LAUNCH time,
// because the toolchain has no such component:
//
//   error: Unknown binary 'rust-analyzer.exe' in official toolchain
//   'stable-x86_64-pc-windows-msvc'.
//
// Because the hint system keys off "is it on PATH", that failure fell through to
// a bare error popover: the raw message, a Restart button that repeats it, and
// no mention of the one command that fixes it.
//
// The strings below are the ones these tools actually print, not a guess at
// them, and `binaryFailure.test.ts` pins the message from the real incident.

const MISSING_BINARY_MARKERS = [
  "unknown binary", // rustup: the component is not installed for the toolchain
  "not found", // sh's "command not found", and the generic case
  "no such file", // ENOENT on Unix
  "cannot find the file", // Windows CreateProcess
  "is not recognized", // cmd.exe
  "cannot find module", // Node-based servers (pyright, typescript-language-server)
  "enoent", // the same ENOENT, as an error code
];

/**
 * Whether this failure text means the executable could not be launched.
 *
 * Case-insensitive: the same conditions arrive capitalised differently between
 * shells and between the tools' own error paths.
 */
export function looksLikeMissingBinary(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return MISSING_BINARY_MARKERS.some((marker) => lower.includes(marker));
}
