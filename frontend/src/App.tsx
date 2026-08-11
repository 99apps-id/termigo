import { KeyboardEvent, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';
import { TerminalPane } from './components/TerminalPane';
import type { CLIStatus, FileDocument, FileNode, Workspace } from './types';

const MonacoEditor = lazy(() => import('@monaco-editor/react'));

type BottomPanel = 'terminal' | 'preview';

function App() {
	const [workspace, setWorkspace] = useState<Workspace>({ path: '', tree: [] });
	const [document, setDocument] = useState<FileDocument | null>(null);
	const [contents, setContents] = useState('');
	const [isDirty, setIsDirty] = useState(false);
	const [status, setStatus] = useState('Open a folder to start a workspace.');
	const [providers, setProviders] = useState<CLIStatus[]>([]);
	const [bottomPanel, setBottomPanel] = useState<BottomPanel>('terminal');
	const [previewURL, setPreviewURL] = useState('http://localhost:5173');

	const refreshProviders = useCallback(async () => {
		try {
			const result = await window.go.main.App.DetectCLIs();
			setProviders(result);
		} catch (error) {
			setStatus(`Unable to inspect local CLIs: ${messageFromError(error)}`);
		}
	}, []);

	const openWorkspace = useCallback(async () => {
		try {
			const nextWorkspace = await window.go.main.App.OpenWorkspace();
			if (!nextWorkspace.path) {
				return;
			}
			setWorkspace(nextWorkspace);
			setDocument(null);
			setContents('');
			setIsDirty(false);
			setStatus(`Workspace opened: ${nextWorkspace.path}`);
			void refreshProviders();
		} catch (error) {
			setStatus(`Unable to open workspace: ${messageFromError(error)}`);
		}
	}, [refreshProviders]);

	const openFile = useCallback(async (path: string) => {
		try {
			const nextDocument = await window.go.main.App.ReadTextFile(path);
			setDocument(nextDocument);
			setContents(nextDocument.contents);
			setIsDirty(false);
			setStatus(nextDocument.path);
		} catch (error) {
			setStatus(`Unable to open file: ${messageFromError(error)}`);
		}
	}, []);

	const saveFile = useCallback(async () => {
		if (!document) {
			return;
		}
		try {
			await window.go.main.App.SaveTextFile(document.path, contents);
			setIsDirty(false);
			setStatus(`Saved ${document.path}`);
		} catch (error) {
			setStatus(`Unable to save: ${messageFromError(error)}`);
		}
	}, [contents, document]);

	useEffect(() => {
		void refreshProviders();
	}, [refreshProviders]);

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
				event.preventDefault();
				void saveFile();
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [saveFile]);

	const activeProviderCount = useMemo(() => providers.filter(provider => provider.available).length, [providers]);

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand"><span className="brand-mark">T</span><span><strong>Termigo</strong></span></div>
				<div className="workspace-name">{workspace.path ? baseName(workspace.path) : 'No workspace open'}</div>
				<div className="topbar-actions">
					<button className="button ghost" onClick={() => void refreshProviders()}>Refresh CLIs</button>
					<button className="button primary" onClick={() => void openWorkspace()}>Open Folder</button>
				</div>
			</header>

			<div className="workspace-shell">
				<aside className="sidebar explorer">
					<div className="pane-heading"><span>EXPLORER</span><button className="icon-button" title="Open folder" onClick={() => void openWorkspace()}>+</button></div>
					{workspace.path ? <FileTree nodes={workspace.tree} onOpen={openFile} /> : <EmptyExplorer onOpen={openWorkspace} />}
				</aside>

				<main className="main-area">
					<section className="editor-panel">
						<div className="tab-strip">
							{document ? <div className="editor-tab"><span className="file-dot">{isDirty ? '●' : '○'}</span>{baseName(document.path)}</div> : <div className="editor-tab muted">Welcome</div>}
							{document && <button className="button save" disabled={!isDirty} onClick={() => void saveFile()}>Save <kbd>Ctrl+S</kbd></button>}
						</div>
						<div className="editor-surface">
							{document ? (
								<Suspense fallback={<div className="loading">Loading editor…</div>}>
									<MonacoEditor
										height="100%"
										language={document.language}
										theme="vs-dark"
										value={contents}
										onChange={value => { setContents(value ?? ''); setIsDirty(true); }}
										options={{ automaticLayout: true, fontSize: 14, minimap: { enabled: false }, padding: { top: 14 }, scrollBeyondLastLine: false }}
									/>
								</Suspense>
							) : <Welcome onOpen={openWorkspace} />}
						</div>
					</section>

					<section className="bottom-panel">
						<div className="panel-tabs">
							<button className={bottomPanel === 'terminal' ? 'panel-tab active' : 'panel-tab'} onClick={() => setBottomPanel('terminal')}>Terminal</button>
							<button className={bottomPanel === 'preview' ? 'panel-tab active' : 'panel-tab'} onClick={() => setBottomPanel('preview')}>Preview</button>
						</div>
						{bottomPanel === 'terminal' ? <TerminalPane workspacePath={workspace.path} onStatus={setStatus} /> : <Preview value={previewURL} onChange={setPreviewURL} />}
					</section>
				</main>

				<aside className="sidebar providers">
					<div className="pane-heading"><span>LOCAL PROVIDERS</span><span className="count">{activeProviderCount}</span></div>
					<p className="provider-intro">CLI and local endpoints only. API keys are intentionally not configured in this first build.</p>
					<div className="provider-list">
						{providers.map(provider => <ProviderCard provider={provider} key={provider.id} />)}
					</div>
					<div className="agent-note"><strong>Next:</strong> provider accounts, OAuth, skills, MCP, and approval-gated agent tools.</div>
				</aside>
			</div>

			<footer className="statusbar"><span>{status}</span><span>{workspace.path ? 'Local workspace' : 'Ready'} · {activeProviderCount} CLI available</span></footer>
		</div>
	);
}

function FileTree({ nodes, onOpen }: { nodes: FileNode[]; onOpen: (path: string) => void }) {
	return <ul className="file-tree">{nodes.map(node => <FileTreeNode key={node.path} node={node} onOpen={onOpen} />)}</ul>;
}

function FileTreeNode({ node, onOpen }: { node: FileNode; onOpen: (path: string) => void }) {
	const [expanded, setExpanded] = useState(true);
	if (node.isDir) {
		return <li><button className="tree-item directory" onClick={() => setExpanded(!expanded)}><span>{expanded ? '⌄' : '›'}</span><span>⌁</span>{node.name}</button>{expanded && <FileTree nodes={node.children} onOpen={onOpen} />}</li>;
	}
	return <li><button className="tree-item file" onClick={() => onOpen(node.path)}><span className="file-spacer" /><span>·</span>{node.name}</button></li>;
}

function EmptyExplorer({ onOpen }: { onOpen: () => void }) {
	return <div className="empty-explorer"><p>No folder open.</p><button className="text-button" onClick={onOpen}>Open a workspace</button></div>;
}

function Welcome({ onOpen }: { onOpen: () => void }) {
	return <div className="welcome"><div className="welcome-mark">T</div><h1>Build with a lighter workspace.</h1><p>Open a folder, edit locally, run commands, and connect an installed agent CLI.</p><button className="button primary" onClick={onOpen}>Open Folder</button><div className="welcome-grid"><span>Explorer</span><span>Monaco editor</span><span>Terminal</span><span>Local preview</span><span>CLI providers</span><span>Private by default</span></div></div>;
}

function Preview({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const [draft, setDraft] = useState(value);
	const submit = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			onChange(draft);
		}
	};
	return <div className="preview"><div className="preview-bar"><input aria-label="Preview URL" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={submit} /><button className="button ghost" onClick={() => onChange(draft)}>Load</button></div><iframe title="Local preview" src={value} sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin" /></div>;
}

function ProviderCard({ provider }: { provider: CLIStatus }) {
	return <article className="provider-card"><div className="provider-card-title"><span className={provider.available ? 'provider-state ready' : 'provider-state'} /> <strong>{provider.label}</strong></div><p>{provider.available ? provider.version || 'Installed' : `Install ${provider.command} to enable`}</p><span>{provider.available ? 'Local CLI ready' : 'Not detected'}</span></article>;
}

function baseName(path: string) {
	return path.replace(/\\/g, '/').split('/').pop() || path;
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export default App;
