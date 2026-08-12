import { invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { TerminalInfo, TerminalRead } from './types';
import '@xterm/xterm/css/xterm.css';

export default function TerminalPane({ workspacePath, onStatus }: { workspacePath: string; onStatus: (next: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<number | null>(null);
  const cursorRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: {
        background: '#0b0e14',
        foreground: '#dce7ff',
        cursor: '#9fb7ff',
        selectionBackground: '#344b7b',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    let disposed = false;
    let timer: number | undefined;
    const resize = () => fit.fit();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const input = terminal.onData(data => {
      const id = sessionRef.current;
      if (!id) return;
      echoTerminalInput(terminal, data);
      void invoke('terminal_write', { id, data }).catch(error => onStatus(`Terminal input failed: ${message(error)}`));
    });

    const poll = async (id: number) => {
      if (disposed || sessionRef.current !== id) return;
      try {
        const update = await invoke<TerminalRead>('terminal_read', { id, cursor: cursorRef.current });
        if (update.contents) terminal.write(update.contents);
        cursorRef.current = update.cursor;
        if (update.closed) {
          terminal.writeln('\r\n\x1b[90mTerminal session ended.\x1b[0m');
          sessionRef.current = null;
          return;
        }
      } catch (error) {
        terminal.writeln(`\r\n\x1b[31mTerminal error: ${message(error)}\x1b[0m`);
        sessionRef.current = null;
        return;
      }
      timer = window.setTimeout(() => void poll(id), 50);
    };

    const start = async () => {
      terminal.writeln('\x1b[90mStarting local terminal...\x1b[0m');
      try {
        const info = await invoke<TerminalInfo>('terminal_start');
        if (disposed) {
          void invoke('terminal_close', { id: info.id });
          return;
        }
        sessionRef.current = info.id;
        cursorRef.current = 0;
        terminal.writeln(`\x1b[90m${info.shell} - ${info.cwd}\x1b[0m\r\n`);
        resize();
        void poll(info.id);
        terminal.focus();
      } catch (error) {
        terminal.writeln(`\x1b[31mCould not start terminal: ${message(error)}\x1b[0m`);
        onStatus(`Could not start terminal: ${message(error)}`);
      }
    };

    const frame = window.requestAnimationFrame(() => {
      resize();
      void start();
    });
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id) void invoke('terminal_close', { id });
      terminal.dispose();
    };
  }, [onStatus, workspacePath]);

  return <section className="terminal-panel" aria-label="Integrated terminal">
    <div className="terminal-heading"><span>TERMINAL</span><span>workspace shell - pipe mode</span></div>
    <div className="terminal-host" ref={hostRef} />
  </section>;
}

function echoTerminalInput(terminal: Terminal, data: string) {
  if (data === '\r') {
    terminal.write('\r\n');
    return;
  }
  if (data === '\u007f') {
    terminal.write('\b \b');
    return;
  }
  if (!data.includes('\u001b')) terminal.write(data);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
