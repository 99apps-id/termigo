import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';

loader.config({ monaco });

monaco.languages.register({ aliases: ['JSON', 'json'], extensions: ['.json'], id: 'json' });
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/(true|false|null)/, 'keyword'],
    ],
  },
});

self.MonacoEnvironment = {
  getWorker(_workerId: string, _label: string) {
    return new editorWorker();
  },
};

export default function CodeEditor({
  path,
  language,
  value,
  dirty,
  onChange,
  onSave,
}: {
  path: string;
  language: string;
  value: string;
  dirty: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  const onMount: OnMount = (editor, monacoApi) => {
    editor.addAction({
      id: 'termigo.save-file',
      label: 'Save file',
      keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS],
      run: onSave,
    });
  };

  return <div className="code-editor">
    <Editor
      path={path}
      language={language}
      value={value}
      theme="termigo-dark"
      beforeMount={monacoApi => {
        monacoApi.editor.defineTheme('termigo-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': '#0e1118',
            'editorGutter.background': '#0e1118',
            'editorLineNumber.foreground': '#526079',
            'editorLineNumber.activeForeground': '#9eafcf',
            'editor.selectionBackground': '#29436f',
            'editor.inactiveSelectionBackground': '#223755',
          },
        });
      }}
      onMount={onMount}
      onChange={next => onChange(next ?? '')}
      options={{
        automaticLayout: true,
        cursorBlinking: 'smooth',
        fontFamily: 'Cascadia Code, Consolas, monospace',
        fontSize: 14,
        lineHeight: 22,
        minimap: { enabled: false },
        padding: { top: 12, bottom: 12 },
        renderWhitespace: 'selection',
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: 'off',
      }}
    />
    <span className="editor-status">{dirty ? 'Unsaved changes' : language}</span>
  </div>;
}
