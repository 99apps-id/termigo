import { useState } from 'react';

const defaultUrl = 'http://localhost:5173';

export default function PreviewPane() {
  const [draft, setDraft] = useState(defaultUrl);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  const openPreview = () => {
    const next = localPreviewUrl(draft);
    if (!next) {
      setError('Only http(s) localhost or 127.0.0.1 preview URLs are allowed.');
      return;
    }
    setError('');
    setUrl(next);
  };

  return <section className="preview-pane">
    <div className="preview-toolbar">
      <form onSubmit={event => { event.preventDefault(); openPreview(); }}>
        <input aria-label="Local preview URL" value={draft} onChange={event => setDraft(event.target.value)} placeholder="http://localhost:5173" spellCheck={false} />
        <button className="button primary" type="submit">Open Preview</button>
      </form>
      <span>Local only</span>
    </div>
    {error ? <div className="preview-message error">{error}</div> : null}
    {url ? <iframe className="preview-frame" src={url} title="Local preview" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" /> : <PreviewWelcome onOpen={openPreview} />}
  </section>;
}

function PreviewWelcome({ onOpen }: { onOpen: () => void }) {
  return <div className="preview-message">
    <h2>Local preview</h2>
    <p>Start a project server in the terminal, then open its localhost URL here.</p>
    <code>npm run dev</code>
    <button className="button primary" onClick={onOpen}>Open localhost:5173</button>
  </div>;
}

function localPreviewUrl(value: string) {
  try {
    const url = new URL(value.trim());
    const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return localHost && (url.protocol === 'http:' || url.protocol === 'https:') ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
