const fs = require("fs");
const ts = require("C:/project/termigo/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js");

const files = [
  "src/modules/ai/tools/context.ts",
  "src/modules/ai/tools/fs.ts",
  "src/modules/ai/tools/context.test.ts",
  "src/modules/ai/lib/useAiLiveBridge.ts",
  "src/modules/terminal/lib/useTerminalSession.ts",
  "src/modules/terminal/index.ts",
  "src/modules/ai/store/chatStore.ts",
  "src/modules/ai/store/chatRuntime.ts",
];

const options = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  isolatedModules: true,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
};

let failed = false;
for (const rel of files) {
  const path = `C:/project/termigo/${rel}`;
  const src = fs.readFileSync(path, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: options,
    fileName: rel,
    reportDiagnostics: true,
  });
  const diags = (out.diagnostics || []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (diags.length > 0) {
    failed = true;
    console.log(`FAIL ${rel}`);
    for (const d of diags) {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      console.log(`  ${pos ? `${pos.line + 1}:${pos.character + 1}` : "?"} ${msg}`);
    }
  } else {
    console.log(`OK   ${rel}`);
  }
}
process.exit(failed ? 1 : 0);
