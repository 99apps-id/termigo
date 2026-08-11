import { KeyboardEvent, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Quit, WindowMinimise, WindowToggleMaximise } from '../wailsjs/runtime/runtime';
import termigoMark from './assets/images/termigo-mark.png';
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
	const [status, setStatus] = useState('Pilih Open Folder untuk memulai.');
	const [providers, setProviders] = useState<CLIStatus[]>([]);
	const [bottomPanel, setBottomPanel] = useState<BottomPanel>('terminal');
	const [isBottomPanelOpen, setIsBottomPanelOpen] = useState(true);
	const [isToolsOpen, setIsToolsOpen] = useState(false);
	const [terminalCommand, setTerminalCommand] = useState<string | null>(null);
	const [previewURL, setPreviewURL] = useState('http://localhost:5173');

	const refreshProviders = useCallback(async () => {
		try {
			setProviders(await window.go.main.App.DetectCLIs());
		} catch (error) {
			setStatus(`Tidak dapat memeriksa CLI lokal: ${messageFromError(error)}`);
		}
	}, []);

	const refreshWorkspace = useCallback(async () => {
		if (!workspace.path) {
			return;
		}
		try {
			const nextWorkspace = await window.go.main.App.RefreshWorkspace();
			setWorkspace(nextWorkspace);
			setStatus('Explorer diperbarui.');
		} catch (error) {
			setStatus(`Tidak dapat memperbarui explorer: ${messageFromError(error)}`);
		}
	}, [workspace.path]);

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
			setBottomPanel('terminal');
			setIsBottomPanelOpen(true);
			setStatus(`Workspace dibuka: ${nextWorkspace.path}`);
			void refreshProviders();
		} catch (error) {
			setStatus(`Tidak dapat membuka folder: ${messageFromError(error)}`);
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
			setStatus(`Tidak dapat membuka berkas: ${messageFromError(error)}`);
		}
	}, []);

	const saveFile = useCallback(async () => {
		if (!document) {
			return;
		}
		try {
			await window.go.main.App.SaveTextFile(document.path, contents);
			setIsDirty(false);
			setStatus(`Tersimpan: ${document.path}`);
		} catch (error) {
			setStatus(`Tidak dapat menyimpan berkas: ${messageFromError(error)}`);
		}
	}, [contents, document]);

	const closeDocument = useCallback(() => {
		if (isDirty && !window.confirm('Perubahan belum disimpan. Tutup tab ini?')) {
			return;
		}
		setDocument(null);
		setContents('');
		setIsDirty(false);
		setStatus('Tab editor ditutup.');
	}, [isDirty]);

	const showPanel = useCallback((panel: BottomPanel) => {
		setBottomPanel(panel);
		setIsBottomPanelOpen(true);
	}, []);

	const runProvider = useCallback((provider: CLIStatus) => {
		if (!workspace.path) {
			setStatus('Buka folder terlebih dahulu sebelum menjalankan agent.');
			return;
		}
		setIsToolsOpen(false);
		showPanel('terminal');
		setTerminalCommand(`${provider.command}\r`);
	}, [showPanel, workspace.path]);

	const clearTerminalCommand = useCallback(() => setTerminalCommand(null), []);

	const quitApp = useCallback(() => {
		if (isDirty && !window.confirm('Perubahan belum disimpan. Keluar dari Termigo?')) {
			return;
		}
		Quit();
	}, [isDirty]);

	useEffect(() => {
		void refreshProviders();
	}, [refreshProviders]);

	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
				event.preventDefault();
				void saveFile();
			}
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
				event.preventDefault();
				void openWorkspace();
			}
			if ((event.ctrlKey || event.metaKey) && event.key === '`') {
				event.preventDefault();
				showPanel('terminal');
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [openWorkspace, saveFile, showPanel]);

	const activeProviderCount = useMemo(() => providers.filter(provider => provider.available).length, [providers]);

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand"><img className="brand-mark" src={termigoMark} alt="" /><strong>Termigo</strong><span className="brand-tag">local workspace</span></div>
				<div className="workspace-name" title={workspace.path || undefined}>{workspace.path ? baseName(workspace.path) : 'Belum ada folder'}</div>
				<div className="topbar-actions">
					<button className="button ghost" onClick={() => showPanel('terminal')} title="Tampilkan terminal (Ctrl+`)">Terminal</button>
					<button className="button ghost" onClick={() => showPanel('preview')}>Preview</button>
					<div className="tools-wrap">
						<button className="button ghost" onClick={() => setIsToolsOpen(value => !value)} aria-expanded={isToolsOpen}>Tools <span className="button-count">{activeProviderCount}</span></button>
						{isToolsOpen && <ToolsMenu providers={providers} onRefresh={refreshProviders} onRun={runProvider} />}
					</div>
					<button className="button primary" onClick={() => void openWorkspace()}>Open Folder <kbd>Ctrl+O</kbd></button>
				</div>
				<div className="window-actions" aria-label="Kontrol jendela">
					<button className="window-button" title="Minimize" onClick={WindowMinimise}>−</button>
					<button className="window-button" title="Maximize atau restore" onClick={WindowToggleMaximise}>□</button>
					<button className="window-button close-window" title="Tutup Termigo" onClick={quitApp}>×</button>
				</div>
			</header>

			<div className="workspace-shell">
				<aside className="sidebar explorer">
					<div className="pane-heading"><span>FILES</span><div className="pane-actions"><button className="icon-button" title="Refresh explorer" disabled={!workspace.path} onClick={() => void refreshWorkspace()}>↻</button><button className="icon-button" title="Open folder" onClick={() => void openWorkspace()}>+</button></div></div>
					{workspace.path ? <FileTree nodes={workspace.tree} selectedPath={document?.path} onOpen={openFile} /> : <EmptyExplorer onOpen={openWorkspace} />}
				</aside>

				<main className={isBottomPanelOpen ? 'main-area' : 'main-area panel-closed'}>
					<section className="editor-panel">
						<div className="tab-strip">
							{document ? <div className="editor-tab"><span className="file-dot">{isDirty ? '●' : '○'}</span><span className="tab-label">{baseName(document.path)}</span><button className="tab-close" title="Tutup tab" onClick={closeDocument}>×</button></div> : <div className="editor-tab muted">{workspace.path ? 'Pilih file dari explorer' : 'Mulai di sini'}</div>}
							{document && <button className="button save" disabled={!isDirty} onClick={() => void saveFile()}>Save <kbd>Ctrl+S</kbd></button>}
						</div>
						<div className="editor-surface">
							{document ? (
								<Suspense fallback={<div className="loading">Memuat editor…</div>}>
									<MonacoEditor height="100%" language={document.language} theme="vs-dark" value={contents} onChange={value => { setContents(value ?? ''); setIsDirty(true); }} options={{ automaticLayout: true, fontSize: 14, minimap: { enabled: false }, padding: { top: 14 }, scrollBeyondLastLine: false }} />
								</Suspense>
							) : <Welcome hasWorkspace={Boolean(workspace.path)} onOpen={openWorkspace} onTerminal={() => showPanel('terminal')} />}
						</div>
					</section>

					{isBottomPanelOpen && <section className="bottom-panel">
						<div className="panel-tabs">
							<button className={bottomPanel === 'terminal' ? 'panel-tab active' : 'panel-tab'} onClick={() => setBottomPanel('terminal')}>Terminal <kbd>Ctrl+`</kbd></button>
							<button className={bottomPanel === 'preview' ? 'panel-tab active' : 'panel-tab'} onClick={() => setBottomPanel('preview')}>Preview</button>
							<button className="panel-close" title="Sembunyikan panel" onClick={() => setIsBottomPanelOpen(false)}>×</button>
						</div>
						<div className="panel-content">
							<div className={bottomPanel === 'terminal' ? 'panel-view active' : 'panel-view'}><TerminalPane workspacePath={workspace.path} active={bottomPanel === 'terminal'} command={terminalCommand} onCommandSent={clearTerminalCommand} onStatus={setStatus} /></div>
							<div className={bottomPanel === 'preview' ? 'panel-view preview-view active' : 'panel-view preview-view'}><Preview value={previewURL} onChange={setPreviewURL} /></div>
						</div>
					</section>}
				</main>
			</div>

			<footer className="statusbar"><span>{status}</span><span>{workspace.path ? 'Workspace lokal' : 'Siap'} · {activeProviderCount} tools tersedia</span></footer>
		</div>
	);
}

function FileTree({ nodes, selectedPath, onOpen }: { nodes: FileNode[]; selectedPath?: string; onOpen: (path: string) => void }) {
	return <ul className="file-tree">{nodes.map(node => <FileTreeNode key={node.path} node={node} selectedPath={selectedPath} onOpen={onOpen} />)}</ul>;
}

function FileTreeNode({ node, selectedPath, onOpen }: { node: FileNode; selectedPath?: string; onOpen: (path: string) => void }) {
	const [expanded, setExpanded] = useState(true);
	if (node.isDir) {
		return <li><button className="tree-item directory" onClick={() => setExpanded(value => !value)}><span className="tree-chevron">{expanded ? '⌄' : '›'}</span><span className="tree-icon">⌁</span><span className="tree-label">{node.name}</span></button>{expanded && <FileTree nodes={node.children} selectedPath={selectedPath} onOpen={onOpen} />}</li>;
	}
	return <li><button className={node.path === selectedPath ? 'tree-item file selected' : 'tree-item file'} onClick={() => onOpen(node.path)}><span className="file-spacer" /><span className="tree-icon">·</span><span className="tree-label">{node.name}</span></button></li>;
}

function EmptyExplorer({ onOpen }: { onOpen: () => void }) {
	return <div className="empty-explorer"><p>Belum ada workspace.</p><button className="text-button" onClick={onOpen}>Open Folder</button></div>;
}

function Welcome({ hasWorkspace, onOpen, onTerminal }: { hasWorkspace: boolean; onOpen: () => void; onTerminal: () => void }) {
	if (hasWorkspace) {
		return <div className="welcome compact"><img className="welcome-mark" src={termigoMark} alt="Termigo" /><h1>Workspace siap.</h1><p>Pilih file di kiri untuk mengedit, atau gunakan terminal di bawah untuk menjalankan perintah.</p><div className="welcome-actions"><button className="button primary" onClick={onTerminal}>Buka Terminal</button><button className="button ghost" onClick={onOpen}>Ganti Folder</button></div></div>;
	}
	return <div className="welcome"><img className="welcome-mark" src={termigoMark} alt="Termigo" /><h1>Mulai dengan satu folder.</h1><p>Termigo menyatukan file, editor, terminal, dan preview untuk proyek lokal Anda.</p><button className="button primary welcome-open" onClick={onOpen}>Open Folder <kbd>Ctrl+O</kbd></button><ol className="getting-started"><li><span>1</span>Pilih folder proyek</li><li><span>2</span>Buka file dari explorer</li><li><span>3</span>Jalankan perintah di Terminal</li></ol></div>;
}

function Preview({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const [draft, setDraft] = useState(value);
	const submit = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			onChange(draft);
		}
	};
	return <div className="preview"><div className="preview-bar"><input aria-label="Preview URL" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={submit} placeholder="http://localhost:3000" /><button className="button ghost" onClick={() => onChange(draft)}>Load</button></div><iframe title="Local preview" src={value} sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin" /></div>;
}

function ToolsMenu({ providers, onRefresh, onRun }: { providers: CLIStatus[]; onRefresh: () => void; onRun: (provider: CLIStatus) => void }) {
	const availableProviders = providers.filter(provider => provider.available);
	return <div className="tools-menu"><div className="tools-menu-heading"><span>TOOLS LOKAL</span><button className="text-button" onClick={() => void onRefresh()}>Refresh</button></div><p>Pilih CLI untuk menjalankannya di terminal workspace. Login dan model tetap dikelola oleh CLI masing-masing.</p>{availableProviders.length ? <div className="tools-list">{availableProviders.map(provider => <button key={provider.id} onClick={() => onRun(provider)}><i />{provider.label}</button>)}</div> : <div className="tools-empty">Belum ada CLI yang terdeteksi.</div>}</div>;
}

function baseName(path: string) {
	return path.replace(/\\/g, '/').split('/').pop() || path;
}

function messageFromError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export default App;
