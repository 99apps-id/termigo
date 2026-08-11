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

export interface CommandResult {
	command: string;
	output: string;
	exitCode: number;
}

export interface CLIStatus {
	id: string;
	label: string;
	command: string;
	available: boolean;
	version: string;
}
