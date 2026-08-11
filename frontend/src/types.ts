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

export interface TerminalSessionInfo {
	id: string;
}

export interface TerminalOutput {
	sessionId: string;
	data: string;
}

export interface TerminalExit {
	sessionId: string;
	exitCode: number;
}

export interface CLIStatus {
	id: string;
	label: string;
	command: string;
	available: boolean;
	version: string;
}
