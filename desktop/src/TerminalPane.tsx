import { invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import type { TerminalInfo, TerminalRead } from './types';
import '@xterm/xterm/css/xterm.css';

interface TerminalTab {
  key: number;
  label: string;
  sessionId: number | null;
  status: 'starting' | 'running' | 'closed';
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement | undefined;
  cursor: number;
  pollTimer: number | undefined;
  observer: ResizeObserver | undefined;
  inputDisposer: { dispose: () => void } | undefined;
}

let nextTabKey = 1;

export default function TerminalPane({ workspacePath, onStatus }: { workspacePath: string; onStatus: (next: string) => void }) {
  const tabsRef = useRef<TerminalTab[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const tab of tabsRef.current) stopTab(tab);
      tabsRef.current = [];
    };
  }, [workspacePath]);

  const makeTerminal = () => {
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: '#0b0e14',
        foreground: '#dce7ff',
        cursor: '#9fb7ff',
        selectionBackground: '#344b7b',
      },
    });
    return { terminal, fit: new FitAddon(), search: new SearchAddon() };
  };

  const refreshTabs = () => {
    if (mountedRef.current) setTabs([...tabsRef.current]);
  };

  const pollTab = (tab: TerminalTab) => {
    const poll = async () => {
      if (!mountedRef.current || tab.sessionId === null) return;
      try {
        const update = await invoke<TerminalRead>('terminal_read', { id: tab.sessionId, cursor: tab.cursor });
        if (!mountedRef.current) return;
        if (update.contents) tab.terminal.write(update.contents);
        tab.cursor = update.cursor;
        if (update.closed) {
          tab.status = 'closed';
          tab.sessionId = null;
          refreshTabs();
          tab.terminal.writeln('\r\n\x1b[90mTerminal session ended.\x1b[0m');
          return;
        }
      } catch (error) {
        tab.status = 'closed';
        tab.sessionId = null;
        refreshTabs();
        tab.terminal.writeln(`\r\n\x1b[31mTerminal error: ${message(error)}\x1b[0m`);
        return;
      }
      if (tab.sessionId !== null) tab.pollTimer = window.setTimeout(() => void poll(), 60);
    };
    void poll();
  };

  const startTab = (tab: TerminalTab) => {
    if (!tab.host) return;
    tab.terminal.loadAddon(tab.fit);
    tab.terminal.loadAddon(tab.search);
    tab.terminal.open(tab.host);

    const resize = () => tab.fit.fit();
    tab.observer = new ResizeObserver(resize);
    tab.observer.observe(tab.host);
    tab.inputDisposer = tab.terminal.onData(data => {
      if (tab.sessionId === null) return;
      echoTerminalInput(tab.terminal, data);
      void invoke('terminal_write', { id: tab.sessionId, data }).catch(error => onStatus(`Terminal input failed: ${message(error)}`));
    });

    tab.terminal.writeln('\x1b[90mStarting local terminal...\x1b[0m');
    void invoke<TerminalInfo>('terminal_start').then(info => {
      if (!mountedRef.current) return;
      tab.sessionId = info.id;
      tab.status = 'running';
      tab.label = info.shell;
      refreshTabs();
      tab.terminal.writeln(`\x1b[90m${info.shell} - ${info.cwd}\x1b[0m\r\n`);
      tab.fit.fit();
      tab.terminal.focus();
      pollTab(tab);
    }).catch(error => {
      tab.status = 'closed';
      refreshTabs();
      tab.terminal.writeln(`\x1b[31mCould not start terminal: ${message(error)}\x1b[0m`);
      onStatus(`Could not start terminal: ${message(error)}`);
    });
  };

  const addTab = () => {
    if (!mountedRef.current) return;
    const { terminal, fit, search } = makeTerminal();
    const tab: TerminalTab = {
      key: nextTabKey++,
      label: 'Terminal',
      sessionId: null,
      status: 'starting',
      terminal,
      fit,
      search,
      host: undefined,
      cursor: 0,
      pollTimer: undefined,
      observer: undefined,
      inputDisposer: undefined,
    };
    tabsRef.current.push(tab);
    setActiveKey(tab.key);
    refreshTabs();
    requestAnimationFrame(() => {
      const hostElement = document.querySelector<HTMLDivElement>(`[data-terminal-host="${tab.key}"]`);
      if (hostElement) {
        tab.host = hostElement;
        startTab(tab);
      }
    });
  };

  const closeTab = (key: number) => {
    const index = tabsRef.current.findIndex(tab => tab.key === key);
    if (index < 0) return;
    const [tab] = tabsRef.current.splice(index, 1);
    stopTab(tab);
    if (tabsRef.current.length === 0) {
      addTab();
    } else if (activeKey === key) {
      setActiveKey(tabsRef.current[Math.min(index, tabsRef.current.length - 1)].key);
    }
    refreshTabs();
  };

  const activateTab = (key: number) => {
    setActiveKey(key);
    const tab = tabsRef.current.find(candidate => candidate.key === key);
    requestAnimationFrame(() => {
      tab?.fit.fit();
      tab?.terminal.focus();
    });
  };

  const searchTerminal = (direction: 'next' | 'previous') => {
    const query = searchRef.current?.value ?? '';
    const active = tabsRef.current.find(tab => tab.key === activeKey);
    if (!active || !query) return;
    if (direction === 'next') active.search.findNext(query);
    else active.search.findPrevious(query);
  };

  useEffect(() => {
    if (tabsRef.current.length === 0) addTab();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(open => {
          if (!open) requestAnimationFrame(() => searchRef.current?.focus());
          return !open;
        });
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') {
        event.preventDefault();
        addTab();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <section className="terminal-panel" aria-label="Integrated terminal">
    <div className="terminal-heading">
      <div className="terminal-tabs">
        {tabs.map(tab => <button key={tab.key} className={tab.key === activeKey ? 'terminal-tab active' : 'terminal-tab'} onClick={() => activateTab(tab.key)}>
          <span className={`terminal-state ${tab.status}`} />{tab.label}
          <span className="terminal-close" onClick={event => { event.stopPropagation(); closeTab(tab.key); }}>×</span>
        </button>)}
        <button className="terminal-add" title="New terminal (Ctrl+T)" onClick={addTab}>+</button>
      </div>
      <div className="terminal-tools">
        <button className="icon-button" title="Search terminal (Ctrl+F)" onClick={() => setSearchOpen(open => !open)}>⌕</button>
      </div>
    </div>
    {searchOpen && <div className="terminal-search">
      <input ref={searchRef} placeholder="Find in terminal…" onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); searchTerminal(event.shiftKey ? 'previous' : 'next'); }
        if (event.key === 'Escape') setSearchOpen(false);
      }} />
      <button className="button ghost" onClick={() => searchTerminal('previous')}>↑</button>
      <button className="button ghost" onClick={() => searchTerminal('next')}>↓</button>
    </div>}
    <div className="terminal-stack">
      {tabs.map(tab => <div key={tab.key} data-terminal-host={tab.key} className="terminal-slot" style={{ display: tab.key === activeKey ? 'block' : 'none' }} />)}
    </div>
  </section>;
}

function stopTab(tab: TerminalTab) {
  if (tab.pollTimer !== undefined) window.clearTimeout(tab.pollTimer);
  if (tab.sessionId !== null) void invoke('terminal_close', { id: tab.sessionId });
  tab.inputDisposer?.dispose();
  tab.observer?.disconnect();
  tab.terminal.dispose();
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

