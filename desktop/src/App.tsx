import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { FileDocument, FileNode, Workspace } from './types';

const emptyWorkspace: Workspace = { path: '', tree: [] };
const TerminalPane = lazy(() => import('./TerminalPane'));
const CodeEditor = lazy(() => import('./CodeEditor'));
const PreviewPane = lazy(() => import('./PreviewPane'));

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [document, setDocument] = useState<FileDocument | null>(null);
  const [contents, setContents] = useState('');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('Open a folder to start a workspace.');
  const [surface, setSurface] = useState<'editor' | 'preview'>('editor');

  const openWorkspace = useCallback(async () => {
    if (dirty && !window.confirm('Discard unsaved changes and open another folder?')) return;
    const selected = await open({ directory: true, multiple: false, title: 'Open workspace' });
    if (!selected || Array.isArray(selected)) return;

    try {
      const next = await invoke<Workspace>('workspace_open', { path: selected });
      setWorkspace(next);
      setDocument(null);
      setContents('');
      setDirty(false);
      setSurface('editor');
      setStatus(`Opened ${next.path}`);
    } catch (error) {
      setStatus(`Could not open workspace: ${message(error)}`);
    }
  }, [dirty]);

  const refreshWorkspace = useCallback(async () => {
    if (!workspace.path) return;
    try {
      setWorkspace(await invoke<Workspace>('workspace_refresh'));
      setStatus('Explorer refreshed.');
    } catch (error) {
      setStatus(`Could not refresh explorer: ${message(error)}`);
    }
  }, [workspace.path]);

  const openFile = useCallback(async (path: string) => {
    if (dirty && !window.confirm('Discard unsaved changes and open another file?')) return;
    try {
      const next = await invoke<FileDocument>('workspace_read_text_file', { path });
      setDocument(next);
      setContents(next.contents);
      setDirty(false);
      setSurface('editor');
      setStatus(next.path);
    } catch (error) {
      setStatus(`Could not open file: ${message(error)}`);
    }
  }, [dirty]);

  const save = useCallback(async () => {
    if (!document) return;
    try {
      await invoke('workspace_save_text_file', { path: document.path, contents });
      setDirty(false);
      setStatus(`Saved ${document.path}`);
    } catch (error) {
      setStatus(`Could not save file: ${message(error)}`);
    }
  }, [contents, document]);

  const closeDocument = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setDocument(null);
    setContents('');
    setDirty(false);
    setStatus('Editor tab closed.');
  }, [dirty]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target instanceof HTMLInputElement || (event.target instanceof Element && event.target.closest('.xterm'))) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void openWorkspace();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openWorkspace, save]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(event => {
      if (dirty && !window.confirm('Discard unsaved changes and close Termigo?')) {
        event.preventDefault();
      }
    }).then(listener => {
      unlisten = listener;
    });
    return () => unlisten?.();
  }, [dirty]);

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-glyph">T</span><strong>Termigo</strong><span>desktop alpha</span></div>
      <div className="workspace-title" title={workspace.path}>{workspace.path ? baseName(workspace.path) : 'No folder open'}</div>
      <div className="topbar-actions">
        <button className="button ghost" onClick={() => void refreshWorkspace()} disabled={!workspace.path}>Refresh</button>
        <button className="button ghost" onClick={() => setSurface('preview')}>Preview</button>
        <button className="button primary" onClick={() => void openWorkspace()}>Open Folder <kbd>Ctrl+O</kbd></button>
      </div>
    </header>

    <div className="workspace-shell">
      <aside className="explorer">
        <div className="pane-heading"><span>FILES</span><button className="icon-button" title="Open folder" onClick={() => void openWorkspace()}>+</button></div>
        {workspace.path ? <FileTree nodes={workspace.tree} activePath={document?.path} onOpen={openFile} /> : <div className="empty-explorer">Choose a project folder to browse its files.</div>}
      </aside>

      <section className="workspace-main">
        <main className="editor-panel">
          <div className="tabbar">
            {document ? <div className={surface === 'editor' ? 'tab' : 'tab inactive'}><button className="tab-select" onClick={() => setSurface('editor')}><span>{dirty ? '●' : '○'}</span><span className="tab-name">{baseName(document.path)}</span></button><button title="Close editor tab" onClick={closeDocument}>×</button></div> : <button className={surface === 'editor' ? 'tab muted tab-select' : 'tab muted inactive tab-select'} onClick={() => setSurface('editor')}>Start here</button>}
            <button className={surface === 'preview' ? 'tab preview-tab tab-select' : 'tab preview-tab inactive tab-select'} onClick={() => setSurface('preview')}>Preview</button>
            {document && surface === 'editor' && <button className="button save" disabled={!dirty} onClick={() => void save()}>Save <kbd>Ctrl+S</kbd></button>}
          </div>
          {surface === 'preview' ? <Suspense fallback={<EditorPlaceholder />}><PreviewPane /></Suspense> : document ? <Suspense fallback={<EditorPlaceholder />}><CodeEditor
            key={document.path}
            path={document.path}
            language={document.language}
            value={contents}
            dirty={dirty}
            onChange={next => { setContents(next); setDirty(true); }}
            onSave={() => void save()}
          /></Suspense> : <Welcome onOpen={openWorkspace} />}
        </main>
        {workspace.path ? <Suspense fallback={<TerminalPlaceholder message="Loading workspace terminal..." />}><TerminalPane key={workspace.path} workspacePath={workspace.path} onStatus={setStatus} /></Suspense> : <TerminalPlaceholder message="Open a folder to start a terminal in that workspace." />}
      </section>
    </div>

    <footer className="statusbar"><span>{status}</span><span>{workspace.path ? 'Local workspace' : 'Ready'}</span></footer>
  </div>;
}

function FileTree({ nodes, activePath, onOpen }: { nodes: FileNode[]; activePath?: string; onOpen: (path: string) => void }) {
  return <ul className="file-tree">{nodes.map(node => <FileTreeNode key={node.path} node={node} activePath={activePath} onOpen={onOpen} />)}</ul>;
}

function FileTreeNode({ node, activePath, onOpen }: { node: FileNode; activePath?: string; onOpen: (path: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  if (node.isDir) {
    return <li><button className="tree-item directory" onClick={() => setExpanded(value => !value)}><span>{expanded ? '⌄' : '›'}</span><span>{node.name}</span></button>{expanded && <FileTree nodes={node.children} activePath={activePath} onOpen={onOpen} />}</li>;
  }
  return <li><button className={activePath === node.path ? 'tree-item active' : 'tree-item'} onClick={() => onOpen(node.path)}><span className="file-marker">·</span><span>{node.name}</span></button></li>;
}

function Welcome({ onOpen }: { onOpen: () => void }) {
  return <section className="welcome"><div className="welcome-mark">T</div><h1>One folder. One focused workspace.</h1><p>Open a local project, browse files, edit safely inside that workspace, and save with familiar shortcuts.</p><button className="button primary welcome-button" onClick={onOpen}>Open Folder <kbd>Ctrl+O</kbd></button><ol><li><span>1</span> Select a local project folder</li><li><span>2</span> Open a text file from Files</li><li><span>3</span> Edit and save with Ctrl+S</li></ol></section>;
}

function TerminalPlaceholder({ message }: { message: string }) {
  return <section className="terminal-panel" aria-label="Integrated terminal">
    <div className="terminal-heading"><span>TERMINAL</span><span>waiting for workspace</span></div>
    <div className="terminal-placeholder">{message}</div>
  </section>;
}

function EditorPlaceholder() {
  return <div className="editor-placeholder">Loading code editor...</div>;
}

function baseName(path: string) {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
