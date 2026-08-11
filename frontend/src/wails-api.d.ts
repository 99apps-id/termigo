import type { CLIStatus, FileDocument, TerminalSessionInfo, Workspace } from './types';

declare global {
	interface Window {
		go: {
			main: {
				App: {
					OpenWorkspace(): Promise<Workspace>;
					CurrentWorkspace(): Promise<Workspace>;
					ReadTextFile(path: string): Promise<FileDocument>;
					SaveTextFile(path: string, contents: string): Promise<void>;
					StartTerminal(columns: number, rows: number): Promise<TerminalSessionInfo>;
					WriteTerminal(sessionID: string, data: string): Promise<void>;
					ResizeTerminal(sessionID: string, columns: number, rows: number): Promise<void>;
					StopTerminal(sessionID: string): Promise<void>;
					DetectCLIs(): Promise<CLIStatus[]>;
				};
			};
		};
	}
}

export {};
