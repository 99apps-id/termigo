import { describe, expect, it } from "vitest";
import type { SourceControlFileEntry } from "../useSourceControlPanel";
import {
  buildFileTree,
  computeFolderCheckState,
  flattenTree,
} from "./fileTree";

function createMockEntry(
  path: string,
  checkState: "checked" | "indeterminate" | "unchecked" = "unchecked",
): SourceControlFileEntry {
  return {
    key: `entry:${path}`,
    path,
    originalPath: null,
    statusCode: "M",
    statusLabel: "modified",
    checkState,
    staged: checkState === "checked",
    unstaged: checkState !== "checked",
    untracked: false,
  };
}

describe("fileTree", () => {
  it("compacts single-child directory chains", () => {
    const entries: SourceControlFileEntry[] = [
      createMockEntry("src/modules/source-control/SourceControlPanel.tsx"),
      createMockEntry("src/modules/source-control/useSourceControlPanel.ts"),
    ];

    const tree = buildFileTree(entries);
    expect(tree.children).toHaveLength(1);

    const folder = tree.children[0];
    expect(folder.kind).toBe("folder");
    if (folder.kind === "folder") {
      expect(folder.name).toBe("src/modules/source-control");
      expect(folder.path).toBe("src/modules/source-control");
      expect(folder.allEntries).toHaveLength(2);
      expect(folder.children).toHaveLength(2);
      expect(folder.children[0].name).toBe("SourceControlPanel.tsx");
      expect(folder.children[1].name).toBe("useSourceControlPanel.ts");
    }
  });

  it("handles branch directories without over-compacting", () => {
    const entries: SourceControlFileEntry[] = [
      createMockEntry("src/components/Button.tsx"),
      createMockEntry("src/modules/foo.ts"),
      createMockEntry("README.md"),
    ];

    const tree = buildFileTree(entries);
    // Under root: folder "src" and file "README.md"
    expect(tree.children).toHaveLength(2);

    const first = tree.children[0];
    const second = tree.children[1];
    expect(first.kind).toBe("folder");
    expect(second.kind).toBe("file");
    expect(second.name).toBe("README.md");

    if (first.kind === "folder") {
      expect(first.name).toBe("src");
      // "components" compacted with "Button.tsx", "modules" compacted with "foo.ts"
      expect(first.children).toHaveLength(2);
      expect(first.children[0].name).toBe("components");
      expect(first.children[1].name).toBe("modules");
    }
  });

  it("flattens tree with expansion and collapse", () => {
    const entries: SourceControlFileEntry[] = [
      createMockEntry("src/modules/a.ts"),
      createMockEntry("package.json"),
    ];

    const tree = buildFileTree(entries);
    const collapsedDirs = new Set<string>();

    // When expanded: folder row + file row + root file row
    const expandedRows = flattenTree(tree, collapsedDirs);
    expect(expandedRows).toHaveLength(3);
    expect(expandedRows[0].kind).toBe("tree-folder");
    expect(expandedRows[1].kind).toBe("entry");
    expect(expandedRows[2].kind).toBe("entry");

    // When folder is collapsed: folder row + root file row only
    collapsedDirs.add("src/modules");
    const collapsedRows = flattenTree(tree, collapsedDirs);
    expect(collapsedRows).toHaveLength(2);
    expect(collapsedRows[0].kind).toBe("tree-folder");
    if (collapsedRows[0].kind === "tree-folder") {
      expect(collapsedRows[0].isExpanded).toBe(false);
      expect(collapsedRows[0].fileCount).toBe(1);
    }
    expect(collapsedRows[1].kind).toBe("entry");
    if (collapsedRows[1].kind === "entry") {
      expect(collapsedRows[1].entry.path).toBe("package.json");
    }
  });

  it("computes folder check state accurately", () => {
    const uncheckedEntries = [
      createMockEntry("a.ts", "unchecked"),
      createMockEntry("b.ts", "unchecked"),
    ];
    expect(computeFolderCheckState(uncheckedEntries)).toBe("unchecked");

    const checkedEntries = [
      createMockEntry("a.ts", "checked"),
      createMockEntry("b.ts", "checked"),
    ];
    expect(computeFolderCheckState(checkedEntries)).toBe("checked");

    const mixedEntries = [
      createMockEntry("a.ts", "checked"),
      createMockEntry("b.ts", "unchecked"),
    ];
    expect(computeFolderCheckState(mixedEntries)).toBe("indeterminate");

    const withIndeterminate = [
      createMockEntry("a.ts", "indeterminate"),
      createMockEntry("b.ts", "unchecked"),
    ];
    expect(computeFolderCheckState(withIndeterminate)).toBe("indeterminate");
  });
});
