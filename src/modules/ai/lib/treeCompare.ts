/**
 * Manifest-level comparison of two directory trees.
 *
 * Deliberately content-free. It answers "which files differ" from the
 * path+mtime+size fingerprint a single glob already returns, which is the step
 * a fork-versus-upstream pass needs before it reads anything. Content comes
 * after, from `git diff --no-index` or `read_file`, and only for the paths this
 * narrowed down.
 */

/** One file as `fs_glob` reports it. `rel` is the comparison key, so both trees
 *  are compared relative to their own root. */
export type TreeFile = {
  rel: string;
  path: string;
  mtime: number;
  size: number;
};

export type TreeDiff = {
  /** Present in the left tree only. */
  onlyInLeft: TreeFile[];
  /** Present in the right tree only. */
  onlyInRight: TreeFile[];
  /** Present in both, with a different size or modification time. */
  changed: { left: TreeFile; right: TreeFile }[];
  /** Present in both and identical by fingerprint. */
  identical: number;
};

export function diffTrees(left: TreeFile[], right: TreeFile[]): TreeDiff {
  const leftByRel = new Map(left.map((f) => [f.rel, f]));
  const rightByRel = new Map(right.map((f) => [f.rel, f]));

  const onlyInLeft: TreeFile[] = [];
  const onlyInRight: TreeFile[] = [];
  const changed: { left: TreeFile; right: TreeFile }[] = [];
  let identical = 0;

  for (const [, l] of leftByRel) {
    const r = rightByRel.get(l.rel);
    if (!r) {
      onlyInLeft.push(l);
    } else if (l.size !== r.size || l.mtime !== r.mtime) {
      changed.push({ left: l, right: r });
    } else {
      identical++;
    }
  }
  for (const [, r] of rightByRel) {
    if (!leftByRel.has(r.rel)) onlyInRight.push(r);
  }

  // Sorted so two runs over the same pair of trees report in the same order.
  const byRel = (a: TreeFile, b: TreeFile) => a.rel.localeCompare(b.rel);
  onlyInLeft.sort(byRel);
  onlyInRight.sort(byRel);
  changed.sort((a, b) => byRel(a.left, b.left));

  return { onlyInLeft, onlyInRight, changed, identical };
}

/** Case-insensitive substring filter over the tree-relative path. */
export function filterByRel(files: TreeFile[], filter: string): TreeFile[] {
  const needle = filter.toLowerCase();
  return files.filter((f) => f.rel.toLowerCase().includes(needle));
}
