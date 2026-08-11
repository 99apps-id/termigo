import type { CLIStatus, CommandResult, FileDocument, Workspace } from './types';

declare global {
	interface Window {
		go: {
			main: {
				App: {
					OpenWorkspace(): Promise<Workspace>;
					CurrentWorkspace(): Promise<Workspace>;
					ReadTextFile(path: string): Promise<FileDocument>;
					SaveTextFile(path: string, contents: string): Promise<void>;
					RunCommand(command: string): Promise<CommandResult>;
					DetectCLIs(): Promise<CLIStatus[]>;
				};
			};
		};
	}
}

export {};
