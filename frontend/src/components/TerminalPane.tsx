import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import '@xterm/xterm/css/xterm.css';
import type { TerminalExit, TerminalOutput, TerminalSessionInfo } from '../types';

const terminalOutputEvent = 'termigo:terminal-output';
const terminalExitEvent = 'termigo:terminal-exit';

interface TerminalPaneProps {
	workspacePath: string;
	active: boolean;
	onStatus: (message: string) => void;
}

export function TerminalPane({ workspacePath, active, onStatus }: TerminalPaneProps) {
	const host = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const statusRef = useRef(onStatus);

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
		terminalRef.current = terminal;
		fitRef.current = fit;

		let disposed = false;
		let sessionID = '';
		let queuedInput = '';
		let writeQueue = Promise.resolve();

		const sendInput = (data: string) => {
			if (!sessionID) {
				queuedInput += data;
				return;
			}
			writeQueue = writeQueue
				.then(() => window.go.main.App.WriteTerminal(sessionID, data))
				.catch(error => {
					terminal.writeln(`\r\n\x1b[31m${messageFromError(error)}\x1b[0m`);
					statusRef.current('Terminal input could not be sent.');
				});
		};

		const unsubscribeOutput = EventsOn(terminalOutputEvent, (event: TerminalOutput) => {
			if (!sessionID || event.sessionId === sessionID) {
				terminal.write(event.data);
			}
		});
		const unsubscribeExit = EventsOn(terminalExitEvent, (event: TerminalExit) => {
			if (event.sessionId !== sessionID) {
				return;
			}
			terminal.writeln(`\r\n\x1b[33mTerminal exited with code ${event.exitCode}.\x1b[0m`);
			statusRef.current(`Terminal exited with code ${event.exitCode}.`);
		});
		const inputListener = terminal.onData(sendInput);

		const resizeTerminal = () => {
			fit.fit();
			if (sessionID) {
				void window.go.main.App.ResizeTerminal(sessionID, terminal.cols, terminal.rows).catch(error => {
					statusRef.current(`Terminal resize failed: ${messageFromError(error)}`);
				});
			}
		};
		const observer = new ResizeObserver(resizeTerminal);
		observer.observe(host.current);

		const startTerminal = async () => {
			if (!workspacePath) {
				terminal.writeln('\x1b[1;36mTermigo terminal\x1b[0m');
				terminal.writeln('Open a folder to start an interactive terminal.');
				return;
			}
			try {
				const session = await window.go.main.App.StartTerminal(terminal.cols, terminal.rows) as TerminalSessionInfo;
				if (disposed) {
					window.go.main.App.StopTerminal(session.id);
					return;
				}
				sessionID = session.id;
				if (queuedInput) {
					const input = queuedInput;
					queuedInput = '';
					sendInput(input);
				}
				statusRef.current(`Interactive terminal started in ${workspacePath}`);
				resizeTerminal();
			} catch (error) {
				terminal.writeln(`\x1b[31m${messageFromError(error)}\x1b[0m`);
				statusRef.current('Interactive terminal could not be started.');
			}
		};
		void startTerminal();

		return () => {
			disposed = true;
			observer.disconnect();
			inputListener.dispose();
			unsubscribeOutput();
			unsubscribeExit();
			if (sessionID) {
				window.go.main.App.StopTerminal(sessionID);
			}
			terminalRef.current = null;
			fitRef.current = null;
			terminal.dispose();
		};
	}, [workspacePath]);

	useEffect(() => {
		if (!active || !terminalRef.current || !fitRef.current) {
			return;
		}
		requestAnimationFrame(() => {
			fitRef.current?.fit();
			terminalRef.current?.focus();
		});
	}, [active]);

	return <div className="terminal-host" ref={host} />;
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
