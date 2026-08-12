export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface Workspace {
  path: string;
  tree: FileNode[];
}

export interface FileDocument {
  path: string;
  contents: string;
  language: string;
}
