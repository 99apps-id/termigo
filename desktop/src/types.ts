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

export interface TerminalInfo {
  id: number;
  shell: string;
  cwd: string;
}

export interface TerminalRead {
  contents: string;
  cursor: number;
  closed: boolean;
}

export interface AgentStatus {
  available: boolean;
  authenticated: boolean;
  version?: string;
  detail: string;
}

export interface AgentInfo {
  id: number;
  provider: string;
  cwd: string;
  access: 'read-only' | 'workspace-write';
}

export interface AgentEvent {
  cursor: number;
  kind: 'assistant' | 'status' | 'error';
  text: string;
}

export interface AgentRead {
  events: AgentEvent[];
  cursor: number;
  closed: boolean;
}

export interface GitFile {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  files: GitFile[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: 'project' | 'user';
}

export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  version?: string;
  detail: string;
}
