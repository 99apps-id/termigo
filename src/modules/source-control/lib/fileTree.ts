import type {
  CheckState,
  SourceControlFileEntry,
} from "../useSourceControlPanel";

export type ViewMode = "list" | "tree";

export type TreeFileNode = {
  kind: "file";
  name: string;
  path: string;
  entry: SourceControlFileEntry;
};

export type TreeFolderNode = {
  kind: "folder";
  name: string;
  path: string;
  children: (TreeFolderNode | TreeFileNode)[];
  allEntries: SourceControlFileEntry[];
};

export type SCMTreeFolderRow = {
  kind: "tree-folder";
  key: string;
  path: string;
  name: string;
  depth: number;
  fileCount: number;
  isExpanded: boolean;
  allEntries: SourceControlFileEntry[];
};

export type SCMTreeEntryRow = {
  kind: "entry";
  key: string;
  entry: SourceControlFileEntry;
  depth: number;
  isTree: true;
};

export type SCMTreeRow = SCMTreeFolderRow | SCMTreeEntryRow;

/**
 * Builds a hierarchical directory tree from flat changed file entries.
 * Compulsorily compacts single-child directory chains (e.g. `src/modules/foo`
 * becomes one row instead of three nested rows), matching modern IDE tree views.
 */
export function buildFileTree(
  entries: SourceControlFileEntry[],
): TreeFolderNode {
  interface RawFolder {
    name: string;
    path: string;
    folders: Map<string, RawFolder>;
    files: Map<string, TreeFileNode>;
  }

  const root: RawFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: new Map(),
  };

  for (const entry of entries) {
    const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
    const fileName = parts.pop() ?? entry.path;
    let current = root;
    let currPath = "";
    for (const folder of parts) {
      currPath = currPath ? `${currPath}/${folder}` : folder;
      let next = current.folders.get(folder);
      if (!next) {
        next = {
          name: folder,
          path: currPath,
          folders: new Map(),
          files: new Map(),
        };
        current.folders.set(folder, next);
      }
      current = next;
    }
    current.files.set(fileName, {
      kind: "file",
      name: fileName,
      path: entry.path,
      entry,
    });
  }

  function convertAndCompact(raw: RawFolder, isRoot: boolean): TreeFolderNode {
    const folderChildren: TreeFolderNode[] = [];
    for (const sub of raw.folders.values()) {
      folderChildren.push(convertAndCompact(sub, false));
    }
    const fileChildren: TreeFileNode[] = Array.from(raw.files.values()).sort(
      (a, b) => a.name.localeCompare(b.name),
    );

    // Compact single-child directory chains unless it is the virtual root
    if (!isRoot && fileChildren.length === 0 && folderChildren.length === 1) {
      const child = folderChildren[0];
      return {
        kind: "folder",
        name: `${raw.name}/${child.name}`,
        path: child.path,
        children: child.children,
        allEntries: child.allEntries,
      };
    }

    folderChildren.sort((a, b) => a.name.localeCompare(b.name));

    const children: (TreeFolderNode | TreeFileNode)[] = [
      ...folderChildren,
      ...fileChildren,
    ];

    const allEntries: SourceControlFileEntry[] = [];
    for (const c of children) {
      if (c.kind === "file") {
        allEntries.push(c.entry);
      } else {
        allEntries.push(...c.allEntries);
      }
    }

    return {
      kind: "folder",
      name: raw.name,
      path: raw.path,
      children,
      allEntries,
    };
  }

  return convertAndCompact(root, true);
}

/**
 * Flattens the hierarchical file tree into linear row descriptors for virtualized rendering.
 * Skips children of folders that are marked collapsed.
 */
export function flattenTree(
  node: TreeFolderNode,
  collapsedDirs: Set<string>,
  depth = 0,
): SCMTreeRow[] {
  const result: SCMTreeRow[] = [];

  for (const child of node.children) {
    if (child.kind === "folder") {
      const isExpanded = !collapsedDirs.has(child.path);
      result.push({
        kind: "tree-folder",
        key: `folder:${child.path}`,
        path: child.path,
        name: child.name,
        depth,
        fileCount: child.allEntries.length,
        isExpanded,
        allEntries: child.allEntries,
      });
      if (isExpanded) {
        result.push(...flattenTree(child, collapsedDirs, depth + 1));
      }
    } else {
      result.push({
        kind: "entry",
        key: child.entry.key,
        entry: child.entry,
        depth,
        isTree: true,
      });
    }
  }

  return result;
}

/**
 * Computes check state (checked, indeterminate, unchecked) for a collection of entries.
 */
export function computeFolderCheckState(
  entries: SourceControlFileEntry[],
): CheckState {
  if (entries.length === 0) return "unchecked";
  let hasChecked = false;
  let hasUnchecked = false;
  for (const entry of entries) {
    if (entry.checkState === "checked") {
      hasChecked = true;
    } else if (entry.checkState === "indeterminate") {
      hasChecked = true;
      hasUnchecked = true;
    } else {
      hasUnchecked = true;
    }
    if (hasChecked && hasUnchecked) return "indeterminate";
  }
  if (hasChecked && !hasUnchecked) return "checked";
  return "unchecked";
}
