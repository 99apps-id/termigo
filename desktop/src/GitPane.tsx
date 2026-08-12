import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';
import type { GitCommit, GitFile, GitStatus } from './types';

interface DiffSelection {
  path: string;
  staged: boolean;
}

const emptyStatus: GitStatus = { branch: '(no branch)', files: [] };

export default function GitPane({ workspacePath, onStatus }: { workspacePath: string; onStatus: (message: string) => void }) {
  const [status, setStatus] = useState<GitStatus>(emptyStatus);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [diff, setDiff] = useState('');
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'changes' | 'history'>('changes');

  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    setLoading(true);
    try {
      const next = await invoke<GitStatus>('git_status');
      setStatus(next);
      const log = await invoke<GitCommit[]>('git_log', { limit: 30 });
      setCommits(log);
    } catch (error) {
      onStatus(`Git: ${errorText(error)}`);
    } finally {
      setLoading(false);
    }
  }, [workspacePath, onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showDiff = async (path: string, staged: boolean) => {
    try {
      const next = await invoke<string>('git_diff', { path, staged });
      setDiff(next);
      setSelection({ path, staged });
    } catch (error) {
      onStatus(`Git diff failed: ${errorText(error)}`);
    }
  };

  const stage = async (paths: string[]) => {
    try {
      await invoke('git_stage', { paths });
      await refresh();
    } catch (error) {
      onStatus(`Git stage failed: ${errorText(error)}`);
    }
  };

  const unstage = async (paths: string[]) => {
    try {
      await invoke('git_unstage', { paths });
      await refresh();
    } catch (error) {
      onStatus(`Git unstage failed: ${errorText(error)}`);
    }
  };

  const commit = async () => {
    if (!message.trim()) return;
    try {
      await invoke('git_commit', { message });
      setMessage('');
      await refresh();
      onStatus(`Committed: ${message.trim()}`);
    } catch (error) {
      onStatus(`Git commit failed: ${errorText(error)}`);
    }
  };

  const unstaged = status.files.filter(file => !file.staged);
  const staged = status.files.filter(file => file.staged);

  return <section className="git-pane" aria-label="Source control">
    <div className="git-heading">
      <div><strong>SOURCE CONTROL</strong><span className="git-branch">{status.branch}</span></div>
      <div className="agent-actions">
        <button className="button ghost" onClick={() => void refresh()} disabled={loading}>Refresh</button>
        <button className="button ghost" onClick={() => setTab(tab === 'changes' ? 'history' : 'changes')}>{tab === 'changes' ? 'History' : 'Changes'}</button>
      </div>
    </div>

    {tab === 'changes' ? <>
      <div className="git-files">
        {status.files.length === 0 && <div className="git-empty">Working tree is clean. Nothing to commit.</div>}
        {staged.length > 0 && <div className="git-group"><span className="git-group-label">STAGED</span>{staged.map(file => <GitFileRow key={`s-${file.path}`} file={file} onDiff={showDiff} onStage={() => unstage([file.path])} stageLabel="Unstage" />)}</div>}
        {unstaged.length > 0 && <div className="git-group"><span className="git-group-label">CHANGES</span>{unstaged.map(file => <GitFileRow key={`u-${file.path}`} file={file} onDiff={showDiff} onStage={() => stage([file.path])} stageLabel="Stage" />)}</div>}
        {status.files.length > 0 && <div className="git-group"><div className="git-group-actions"><button className="button ghost" onClick={() => void stage([])}>Stage all</button></div></div>}
      </div>

      <div className="git-diff">
        <div className="git-diff-heading"><span>{selection ? `${selection.path}${selection.staged ? ' (staged)' : ''}` : 'Select a file to see its diff'}</span>{selection && <button className="button ghost" onClick={() => { setDiff(''); setSelection(null); }}>Close</button>}</div>
        {diff ? <pre className="git-diff-body">{diff}</pre> : <div className="git-diff-placeholder">{selection ? 'No diff output.' : 'Use the terminal or the agent to change files, then review them here.'}</div>}
      </div>

      <form className="git-commit" onSubmit={event => { event.preventDefault(); void commit(); }}>
        <input value={message} onChange={event => setMessage(event.target.value)} placeholder={`Commit message on ${status.branch}`} disabled={!staged.length} />
        <button className="button primary" type="submit" disabled={!message.trim() || !staged.length}>Commit <kbd>Ctrl+Enter</kbd></button>
      </form>
    </> : <div className="git-history">
      {commits.length === 0 && <div className="git-empty">No commits yet.</div>}
      {commits.map(commit => <article className="git-commit-item" key={commit.hash}>
        <span className="git-commit-hash" title={commit.hash}>{commit.shortHash}</span>
        <div className="git-commit-main"><span className="git-commit-message">{commit.message}</span><span className="git-commit-meta">{commit.author} · {formatDate(commit.date)}</span></div>
      </article>)}
    </div>}
  </section>;
}

function GitFileRow({ file, onDiff, onStage, stageLabel }: { file: GitFile; onDiff: (path: string, staged: boolean) => void; onStage: () => void; stageLabel: string }) {
  return <div className="git-file-row">
    <span className={`git-status ${file.staged ? 'staged' : ''}`}>{file.status}</span>
    <button className="git-file-path" title={file.path} onClick={() => void onDiff(file.path, file.staged)}>{baseName(file.path)}</button>
    <span className="git-file-dir">{directoryOf(file.path)}</span>
    <button className="button ghost" onClick={onStage}>{stageLabel}</button>
  </div>;
}

function baseName(path: string) {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function directoryOf(path: string) {
  const parts = path.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
