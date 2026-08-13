// Minimal shim for the local file tree's git-decoration hook. The SSH file
// explorer reuses FileTreeNode, which consumes this hook; Termigo's local
// explorer does not render per-file git status decorations in the tree, so
// the remote tree renders plain rows.
export type Deco = {
  tone: string;
  status: string;
  letter: string;
};

export function useGitDecoration(
  _path: string,
  _isDir: boolean,
): { deco: Deco | null; ignored: boolean } {
  return { deco: null, ignored: false };
}
