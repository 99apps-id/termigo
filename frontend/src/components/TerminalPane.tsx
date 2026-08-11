import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

interface TerminalPaneProps {
	workspacePath: string;
	onStatus: (message: string) => void;
}

export function TerminalPane({ workspacePath, onStatus }: TerminalPaneProps) {
	const host = useRef<HTMLDivElement>(null);
	const workspaceRef = useRef(workspacePath);
	const statusRef = useRef(onStatus);

	useEffect(() => {
		workspaceRef.current = workspacePath;
	}, [workspacePath]);

	useEffect(() => {
		statusRef.current = onStatus;
	}, [onStatus]);

	useEffect(() => {
		if (!host.current) {
			return;
		}

		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: 'Cascadia Code, Consolas, monospace',
			fontSize: 13,
			theme: { background: '#0d111b', foreground: '#dbe5ff', cursor: '#8eb4ff', green: '#6ee7b7', red: '#fb7185' },
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host.current);
		fit.fit();
		terminal.writeln('\x1b[1;36mBatikCode Lite terminal\x1b[0m — commands run in the active workspace.');
		terminal.writeln('Open a folder, then type a command and press Enter.');

		let input = '';
		const prompt = () => terminal.write('\r\n\x1b[1;32m›\x1b[0m ');
		const execute = async () => {
			const command = input.trim();
			input = '';
			if (!command) {
				prompt();
				return;
			}
			if (!workspaceRef.current) {
				terminal.writeln('\r\n\x1b[31mOpen a workspace before running commands.\x1b[0m');
				prompt();
				return;
			}
			try {
				const result = await window.go.main.App.RunCommand(command);
				if (result.output) {
					terminal.write(`\r\n${result.output.replace(/\n/g, '\r\n')}`);
				}
				if (result.exitCode !== 0) {
					terminal.writeln(`\r\n\x1b[31mExited with code ${result.exitCode}.\x1b[0m`);
				}
				statusRef.current(`Command completed: ${command}`);
			} catch (error) {
				terminal.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
				statusRef.current('Command could not be run.');
			}
			prompt();
		};

		const inputListener = terminal.onData(data => {
			if (data === '\r') {
				void execute();
				return;
			}
			if (data === '\u007f') {
				if (input.length > 0) {
					input = input.slice(0, -1);
					terminal.write('\b \b');
				}
				return;
			}
			if (data >= ' ') {
				input += data;
				terminal.write(data);
			}
		});

		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host.current);
		prompt();

		return () => {
			observer.disconnect();
			inputListener.dispose();
			terminal.dispose();
		};
	}, []);

	return <div className="terminal-host" ref={host} />;
}
