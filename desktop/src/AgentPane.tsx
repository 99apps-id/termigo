import { invoke } from '@tauri-apps/api/core';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, AgentInfo, AgentRead, AgentStatus, ProviderStatus } from './types';

type AccessMode = 'read-only' | 'workspace-write';

interface ChatMessage {
  id: number;
  kind: 'user' | AgentEvent['kind'];
  text: string;
}

const unknownStatus: AgentStatus = {
  available: false,
  authenticated: false,
  detail: 'Checking Codex CLI…',
};

export default function AgentPane({ workspacePath, onStatus }: { workspacePath: string; onStatus: (message: string) => void }) {
  const [status, setStatus] = useState<AgentStatus>(unknownStatus);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [access, setAccess] = useState<AccessMode>('read-only');
  const [running, setRunning] = useState(false);
  const activeRun = useRef<number | null>(null);
  const pollTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  const addMessage = useCallback((kind: ChatMessage['kind'], text: string) => {
    setMessages(current => [...current, { id: Date.now() + current.length, kind, text }]);
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const [next, providers] = await Promise.all([
        invoke<AgentStatus>('agent_status'),
        invoke<ProviderStatus[]>('agent_providers'),
      ]);
      if (!mounted.current) return;
      setStatus(next);
      setProviders(providers);
      onStatus(next.detail);
    } catch (error) {
      const detail = `Could not check agent tools: ${message(error)}`;
      if (!mounted.current) return;
      setStatus({ available: false, authenticated: false, detail });
      onStatus(detail);
    }
  }, [onStatus]);

  const poll = useCallback(async (id: number, cursor: number) => {
    try {
      const next = await invoke<AgentRead>('agent_read', { id, cursor });
      if (!mounted.current || activeRun.current !== id) return;
      if (next.events.length) {
        setMessages(current => [...current, ...next.events.map(event => ({
          id: Date.now() + event.cursor,
          kind: event.kind,
          text: event.text,
        }))]);
      }
      if (next.closed) {
        activeRun.current = null;
        setRunning(false);
        onStatus('Codex task finished.');
        return;
      }
      pollTimer.current = window.setTimeout(() => { void poll(id, next.cursor); }, 180);
    } catch (error) {
      if (!mounted.current || activeRun.current !== id) return;
      activeRun.current = null;
      setRunning(false);
      const detail = `Codex run stopped: ${message(error)}`;
      addMessage('error', detail);
      onStatus(detail);
    }
  }, [addMessage, onStatus]);

  useEffect(() => {
    mounted.current = true;
    void checkStatus();
    return () => {
      mounted.current = false;
      if (pollTimer.current !== undefined) window.clearTimeout(pollTimer.current);
      if (activeRun.current !== null) void invoke('agent_cancel', { id: activeRun.current });
    };
  }, [checkStatus]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    const task = prompt.trim();
    if (!task || running) return;
    if (access === 'workspace-write' && !window.confirm(`Allow Codex to edit files and run commands inside this workspace?\n\n${workspacePath}\n\nThis run is limited to the selected workspace.`)) return;

    try {
      setRunning(true);
      addMessage('user', task);
      setPrompt('');
      const run = await invoke<AgentInfo>('agent_start', { prompt: task, access });
      if (!mounted.current) {
        void invoke('agent_cancel', { id: run.id });
        return;
      }
      activeRun.current = run.id;
      onStatus(`Codex started in ${run.cwd} (${run.access}).`);
      void poll(run.id, 0);
    } catch (error) {
      setRunning(false);
      const detail = `Could not start Codex: ${message(error)}`;
      addMessage('error', detail);
      onStatus(detail);
    }
  };

  const cancel = async () => {
    const id = activeRun.current;
    if (id === null) return;
    try {
      await invoke('agent_cancel', { id });
      onStatus('Stopping Codex task…');
    } catch (error) {
      const detail = `Could not stop Codex: ${message(error)}`;
      addMessage('error', detail);
      onStatus(detail);
    }
  };

  const canStart = status.available && status.authenticated && Boolean(workspacePath) && !running && Boolean(prompt.trim());

  return <section className="agent-pane" aria-label="Codex Agent">
    <div className="agent-heading">
      <div><strong>CODEX AGENT</strong><span className={status.authenticated ? 'agent-state connected' : 'agent-state'}>{status.authenticated ? 'ChatGPT connected' : 'Needs sign-in'}</span></div>
      <div className="agent-actions"><button className="button ghost" onClick={() => void checkStatus()} disabled={running}>Check</button><button className="button ghost" onClick={() => setMessages([])} disabled={running || !messages.length}>Clear</button></div>
    </div>

    <div className="agent-providers" aria-label="Installed agent providers">
      {providers.map(provider => <span key={provider.id} className={provider.available ? 'provider-chip ready' : 'provider-chip'} title={provider.detail}>
        <span className="provider-dot" />{provider.name}{provider.version ? <span className="provider-version">{provider.version}</span> : null}
      </span>)}
    </div>

    <div className="agent-transcript" aria-live="polite">
      {!messages.length && <div className="agent-empty"><div className="agent-empty-mark">✦</div><h2>Ask Codex about this workspace.</h2><p>{status.detail}</p><p>Termigo uses your existing Codex ChatGPT sign-in. Transcript stays in this window and each task runs as an ephemeral local Codex session. Other agent CLIs are detected automatically; the <code>termigo</code> CLI can drive any of them.</p></div>}
      {messages.map(item => <article className={`agent-message ${item.kind}`} key={item.id}><span>{labelFor(item.kind)}</span><pre>{item.text}</pre></article>)}
    </div>

    <form className="agent-composer" onSubmit={start}>
      <div className="agent-compose-controls"><label>Access<select value={access} onChange={event => setAccess(event.target.value as AccessMode)} disabled={running}><option value="read-only">Inspect only</option><option value="workspace-write">Edit active workspace</option></select></label><span>{access === 'read-only' ? 'Read-only by default' : 'You will confirm before it starts'}</span></div>
      <textarea value={prompt} onChange={event => setPrompt(event.target.value)} disabled={running || !status.available || !status.authenticated} placeholder={status.authenticated ? 'Explain a bug, ask for a plan, or request a focused change…' : 'Sign in to Codex CLI first…'} rows={3} />
      <div className="agent-submit"><small>Prompt is sent to the installed Codex CLI via stdin. No API key is stored by Termigo.</small>{running ? <button className="button ghost" type="button" onClick={() => void cancel()}>Stop</button> : <button className="button primary" type="submit" disabled={!canStart}>Send to Codex</button>}</div>
    </form>
  </section>;
}

function labelFor(kind: ChatMessage['kind']) {
  if (kind === 'user') return 'YOU';
  if (kind === 'assistant') return 'CODEX';
  if (kind === 'error') return 'ERROR';
  return 'STATUS';
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
