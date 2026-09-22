/**
 * Database Explorer — Termigo extension skeleton
 *
 * Demonstrates:
 *  - bundled sql.js (WASM) loaded via ext_read_asset
 *  - sidebar section for databases / schemas / tables
 *  - host-managed panel (HTML template) for query editor + results
 *  - commands (db:open, db:describe, db:export)
 *  - AI tools (db_describe, db_query)
 *  - settings for recent files and query history
 *
 * v1 scope: SQLite files opened via fs_read_file + sql.js WASM.
 * Remote DB (Postgres/MySQL) can be added later via native Rust commands
 * or a sidecar bridge behind ctx.secrets + ctx.ssh.openForward.
 */

export async function activate(ctx) {
  const {
    contribute,
    settings,
    sidebar,
    commands,
    tabs,
    panel,
    registerAiToolHandler,
    registerCommandHandler,
    logger,
    storage,
    invoke,
  } = ctx;

  // ------------------------------------------------------------------
  // 1. Load sql.js (WASM) from bundled extension assets
  // ------------------------------------------------------------------
  let SQL = null;
  let sqlInitError = null;

  try {
    const sqlWasmText = await invoke("ext_read_asset", {
      id: "database-explorer",
      relPath: "lib/sql-wasm.js",
    });

    // sql-wasm.js is a classic script (not ESM). We load it via new Function()
    // so its `var` declarations leak to the worker global scope, then call
    // `initSqlJs` with our bundled WASM binary.
    const loadSql = new Function(
      sqlWasmText + "\n;return (typeof initSqlJs !== 'undefined' ? initSqlJs : null);",
    );
    const initSqlJs = loadSql();

    if (typeof initSqlJs !== "function") {
      throw new Error("initSqlJs not found after loading sql-wasm.js");
    }

    const b64 = await invoke("ext_read_asset", {
      id: "database-explorer",
      relPath: "lib/sql-wasm.b64",
    });

    const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    SQL = await initSqlJs({ wasmBinary: binary });
    logger.info("sql.js initialized");
  } catch (err) {
    sqlInitError = err instanceof Error ? err : new Error(String(err));
    logger.error("sql.js init failed:", sqlInitError);
  }

  // ------------------------------------------------------------------
  // 2. State
  // ------------------------------------------------------------------
  let recentFiles = [];
  let activeDb = null; // { path, name, db: SQL.Database, tables: [] }

  async function loadRecentFiles() {
    try {
      const raw = await storage.get("recentFiles");
      recentFiles = Array.isArray(raw) ? raw : [];
    } catch {
      recentFiles = [];
    }
  }

  async function saveRecentFiles() {
    await storage.set("recentFiles", recentFiles.slice(0, 20));
  }

  function touchRecent(path) {
    recentFiles = recentFiles.filter((f) => f !== path);
    recentFiles.unshift(path);
    if (recentFiles.length > 20) recentFiles = recentFiles.slice(0, 20);
    saveRecentFiles();
    renderSidebar();
  }

  // ------------------------------------------------------------------
  // 3. SQLite helpers
  // ------------------------------------------------------------------
  function describeTables(db) {
    const stmt = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
    );
    const tables = [];
    if (stmt && stmt.length > 0) {
      const rows = stmt[0].values;
      for (const row of rows) {
        const tableName = row[0];
        const countRow = db.exec(
          `SELECT COUNT(*) FROM "${tableName.replace(/"/g, '""')}";`,
        );
        const rowCount = countRow && countRow.length > 0 ? countRow[0].values[0][0] : 0;
        tables.push({ name: tableName, rows: rowCount });
      }
    }
    return tables;
  }

  function runQueryOnDb(db, sql) {
    const maxRows = (await settings.get("maxRows")) ?? 500;
    const lowered = sql.trim().toLowerCase();
    if (
      lowered.startsWith("insert") ||
      lowered.startsWith("update") ||
      lowered.startsWith("delete") ||
      lowered.startsWith("drop") ||
      lowered.startsWith("alter") ||
      lowered.startsWith("create") ||
      lowered.startsWith("pragma")
    ) {
      throw new Error("Only SELECT queries are allowed in this extension.");
    }

    db.run(sql);
    // For SELECT queries, sql.js returns results in db.exec() or via prepared statements.
    // We use exec for simplicity.
    const results = db.exec(sql);
    if (!results || results.length === 0) {
      return { columns: [], rows: [], rowCount: 0 };
    }
    const first = results[0];
    return {
      columns: first.columns,
      rows: first.values,
      rowCount: first.values.length,
    };
  }

  async function openDatabase(path) {
    try {
      const result = await invoke("fs_read_file", { path });
      let bytes;

      if (result && result.kind === "binary") {
        throw new Error(
          "fs_read_file returned binary without payload; install a newer Termigo build.",
        );
      } else if (result && result.kind === "text") {
        throw new Error(
          "fs_read_file returned text for a binary .db file; install a newer Termigo build.",
        );
      } else if (result && result.kind === "toolarge") {
        throw new Error(
          `File is too large to open in the browser (${result.size} bytes, limit ${result.limit}).`,
        );
      } else if (result && result.kind === "image") {
        throw new Error("Expected a SQLite file, got an image.");
      } else if (result && typeof result === "string") {
        throw new Error(
          "Unexpected fs_read_file payload shape; install a newer Termigo build.",
        );
      } else {
        throw new Error("fs_read_file returned an empty or unknown payload.");
      }
    } catch (err) {
      logger.error("openDatabase read failed:", err);
      ctx.ui.toast(
        `Cannot read ${path}: ${err.message ?? "fs_read_file cannot deliver binary bytes in this build."}`,
      );
      return;
    }
  }

  // ------------------------------------------------------------------
  // 4. Sidebar section
  // ------------------------------------------------------------------
  function renderSidebar() {
    const items = recentFiles.map((path) => ({
      id: `db:${path}`,
      label: path.split(/[\\/]/).pop() || path,
      sublabel: path,
      badge: { text: "SQLite", variant: "secondary" },
      onClick: () => openDatabase(path),
    }));

    sidebar.setSection({
      id: "database-explorer",
      title: "Databases",
      icon: "lucide:database",
      headerActions: [
        {
          id: "refresh",
          icon: "lucide:refresh-cw",
          tooltip: "Refresh recent databases",
          onClick: () => {
            renderSidebar();
            ctx.ui.toast("Refreshed");
          },
        },
      ],
      items,
      emptyText: "No recent SQLite files.",
      searchable: true,
      searchPlaceholder: "Search recent databases…",
    });
  }

  // ------------------------------------------------------------------
  // 5. Panel (host-managed HTML template)
  // ------------------------------------------------------------------
  const panelId = "db-query";

  function buildPanelHtml() {
    const hasError = Boolean(sqlInitError);
    const db = activeDb;

    if (!db) {
      return {
        html: `
          <div style="padding:12px;font-family:system-ui,sans-serif">
            <h3 style="margin:0 0 8px">Database Explorer</h3>
            <p style="margin:0;opacity:0.8">
              ${hasError
                ? `sql.js failed to initialize: ${escapeHtml(sqlInitError.message)}`
                : 'Open a SQLite file from the sidebar.'}
            </p>
            ${hasError ? `<pre style="color:#ff8a8a;margin-top:8px;white-space:pre-wrap">${escapeHtml(sqlInitError.stack ?? sqlInitError.message)}</pre>` : ""}
          </div>
        `,
        events: [],
      };
    }

    const tableRows = (db.tables ?? [])
      .map(
        (t) =>
          `<div style="display:flex;justify-content:space-between;padding:4px 8px;background:rgba(127,127,127,0.08);border-radius:4px;font-size:13px">
            <span>${escapeHtml(t.name)}</span>
            <span style="opacity:0.7">${t.rows} rows</span>
          </div>`,
      )
      .join("");

    return {
      html: `
        <div style="padding:12px;font-family:system-ui,sans-serif">
          <h3 style="margin:0 0 4px">${escapeHtml(db.name)}</h3>
          <div style="font-size:12px;opacity:0.7;margin-bottom:12px">${escapeHtml(db.path)}</div>
          <div style="font-weight:600;margin-bottom:6px">Tables</div>
          <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px">${tableRows || '<div style="opacity:0.7">No tables found.</div>'}</div>
          <label style="font-weight:600;display:block;margin-bottom:6px">SQL</label>
          <textarea data-ext-field="sql" placeholder="SELECT * FROM users LIMIT 100;" style="width:100%;min-height:90px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;padding:8px;border-radius:6px;border:1px solid rgba(127,127,127,0.25);background:transparent;color:inherit;resize:vertical">SELECT 1;</textarea>
          <button data-ext-event="db-run" style="margin-top:8px;padding:6px 12px;border-radius:6px;border:1px solid rgba(127,127,127,0.3);background:transparent;color:inherit;cursor:pointer">Run query</button>
          <div id="db-result" style="margin-top:12px"></div>
        </div>
      `,
      events: ["db-run"],
    };
  }

  function refreshPanel() {
    const { html, events } = buildPanelHtml();
    panel.setView(panelId, html, events);
  }

  panel.on("db-run", async (fields) => {
    const sql = String(fields?.sql ?? "").trim();
    if (!sql) {
      ctx.ui.toast("Enter a SQL query first.");
      return;
    }

    if (!activeDb) {
      ctx.ui.toast("No active database.");
      return;
    }

    try {
      const res = runQueryOnDb(activeDb.db, sql);
      // The host-managed panel doesn't give us direct DOM access from the worker,
      // so we re-render the whole panel with the result embedded.
      const resultBlock = res.rowCount === 0
        ? '<div style="font-size:12px;opacity:0.8">0 rows</div>'
        : `<div style="font-size:12px;opacity:0.8;margin-bottom:6px">${res.rowCount} row${res.rowCount === 1 ? "" : "s"}</div>
           <div style="overflow:auto;max-height:40vh;border-radius:6px;border:1px solid rgba(127,127,127,0.2)">
             <table style="width:100%;border-collapse:collapse;font-size:13px">
               <thead>
                 <tr>${res.columns.map(c => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,0.25);background:rgba(127,127,127,0.08);position:sticky;top:0">${escapeHtml(c)}</th>`).join("")}</tr>
               </thead>
               <tbody>${res.rows.map(row => `<tr>${row.map(cell => `<td style="padding:5px 8px;border-bottom:1px solid rgba(127,127,127,0.1);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${cell === null ? "NULL" : escapeHtml(String(cell))}</td>`).join("")}</tr>`).join("")}</tbody>
             </table>
           </div>`;

      const { html } = buildPanelHtml();
      // Inject the result after the button.
      const injected = html.replace(
        '<div id="db-result" style="margin-top:12px"></div>',
        `<div id="db-result" style="margin-top:12px">${resultBlock}</div>`,
      );
      panel.setView(panelId, injected, ["db-run"]);
    } catch (err) {
      logger.error("runQuery failed:", err);
      const { html } = buildPanelHtml();
      const injected = html.replace(
        '<div id="db-result" style="margin-top:12px"></div>',
        `<div id="db-result" style="margin-top:12px"><pre style="color:#ff8a8a;margin:0;white-space:pre-wrap">${escapeHtml(err.message ?? String(err))}</pre></div>`,
      );
      panel.setView(panelId, injected, ["db-run"]);
    }
  });

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ------------------------------------------------------------------
  // 6. Commands
  // ------------------------------------------------------------------
  contribute.commands([
    {
      id: "db:open",
      title: "Database: Open SQLite file",
      subtitle: "Open a .db file in Database Explorer",
    },
    {
      id: "db:describe",
      title: "Database: Describe active database",
      subtitle: "List tables and row counts for the active database",
    },
    {
      id: "db:export",
      title: "Database: Export query results",
      subtitle: "Save the last query result to CSV",
    },
  ]);

  registerCommandHandler("db:open", async () => {
    ctx.ui.toast("Open a .db file from the sidebar (skeleton)");
  });

  registerCommandHandler("db:describe", async () => {
    if (!activeDb) {
      ctx.ui.toast("No active database. Open one from the sidebar.");
      return;
    }
    const desc = { path: activeDb.path, tables: activeDb.tables ?? [] };
    const summary = desc.tables.map((t) => `${t.name} (${t.rows} rows)`).join(", ");
    ctx.ui.toast(summary || "No tables found.");
  });

  registerCommandHandler("db:export", async () => {
    ctx.ui.toast("Export to CSV (skeleton)");
  });

  // ------------------------------------------------------------------
  // 7. AI tools
  // ------------------------------------------------------------------
  contribute.aiTools([
    {
      name: "db_describe",
      description: "Describe a SQLite database: list tables and row counts.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .db file" },
        },
        required: ["path"],
      },
    },
    {
      name: "db_query",
      description: "Run a read-only SQL query against a SQLite database and return columns + rows.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .db file" },
          sql: { type: "string", description: "SQL query to run" },
        },
        required: ["path", "sql"],
      },
    },
  ]);

  registerAiToolHandler("db_describe", async (args) => {
    const path = String(args?.path ?? "");
    if (!path) return { error: "path is required" };
    return { path, tables: activeDb?.tables ?? [] };
  });

  registerAiToolHandler("db_query", async (args) => {
    const path = String(args?.path ?? "");
    const sql = String(args?.sql ?? "");
    if (!path || !sql) return { error: "path and sql are required" };
    if (!activeDb || activeDb.path !== path) {
      return { error: `Database ${path} is not open. Open it first via db:open.` };
    }
    return runQueryOnDb(activeDb.db, sql);
  });

  // ------------------------------------------------------------------
  // 8. Settings
  // ------------------------------------------------------------------
  contribute.settings([
    {
      key: "maxRows",
      title: "Max rows returned",
      description: "Cap for query results returned by db_query.",
      type: "number",
      default: 500,
    },
    {
      key: "defaultDirectory",
      title: "Default database directory",
      description: "Preferred directory for opening SQLite files.",
      type: "string",
      default: "",
    },
  ]);

  // ------------------------------------------------------------------
  // 9. Init
  // ------------------------------------------------------------------
  await loadRecentFiles();
  renderSidebar();

  // Create a sample in-memory SQLite database to demonstrate sql.js works.
  if (SQL) {
    try {
      const sampleDb = new SQL.Database();
      sampleDb.run(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);",
      );
      sampleDb.run(
        'INSERT INTO users (name, email) VALUES ("Alice", "alice@example.com");',
      );
      sampleDb.run(
        'INSERT INTO users (name, email) VALUES ("Bob", "bob@example.com");',
      );
      sampleDb.run(
        'INSERT INTO users (name, email) VALUES ("Carol", "carol@example.com");',
      );
      sampleDb.run(
        "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, total REAL, created_at TEXT);",
      );
      sampleDb.run(
        'INSERT INTO orders (user_id, total, created_at) VALUES (1, 29.99, "2024-01-01");',
      );
      sampleDb.run(
        'INSERT INTO orders (user_id, total, created_at) VALUES (2, 49.50, "2024-01-02");',
      );
      sampleDb.run(
        'INSERT INTO orders (user_id, total, created_at) VALUES (1, 15.00, "2024-01-03");',
      );

      activeDb = {
        path: ":sample:",
        name: "Sample Database",
        db: sampleDb,
        tables: describeTables(sampleDb),
      };

      // Auto-open the sample panel so the user sees something immediately.
      panel.setView(panelId, buildPanelHtml().html, ["db-run"]);
      panel.on("db-run", async (fields) => {
        const sql = String(fields?.sql ?? "").trim();
        if (!sql) {
          ctx.ui.toast("Enter a SQL query first.");
          return;
        }
        try {
          const res = runQueryOnDb(activeDb.db, sql);
          const resultBlock = res.rowCount === 0
            ? '<div style="font-size:12px;opacity:0.8">0 rows</div>'
            : `<div style="font-size:12px;opacity:0.8;margin-bottom:6px">${res.rowCount} row${res.rowCount === 1 ? "" : "s"}</div>
               <div style="overflow:auto;max-height:40vh;border-radius:6px;border:1px solid rgba(127,127,127,0.2)">
                 <table style="width:100%;border-collapse:collapse;font-size:13px">
                   <thead>
                     <tr>${res.columns.map(c => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid rgba(127,127,127,0.25);background:rgba(127,127,127,0.08);position:sticky;top:0">${escapeHtml(c)}</th>`).join("")}</tr>
                   </thead>
                   <tbody>${res.rows.map(row => `<tr>${row.map(cell => `<td style="padding:5px 8px;border-bottom:1px solid rgba(127,127,127,0.1);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${cell === null ? "NULL" : escapeHtml(String(cell))}</td>`).join("")}</tr>`).join("")}</tbody>
                 </table>
               </div>`;

          const { html } = buildPanelHtml();
          const injected = html.replace(
            '<div id="db-result" style="margin-top:12px"></div>',
            `<div id="db-result" style="margin-top:12px">${resultBlock}</div>`,
          );
          panel.setView(panelId, injected, ["db-run"]);
        } catch (err) {
          logger.error("runQuery failed:", err);
          const { html } = buildPanelHtml();
          const injected = html.replace(
            '<div id="db-result" style="margin-top:12px"></div>',
            `<div id="db-result" style="margin-top:12px"><pre style="color:#ff8a8a;margin:0;white-space:pre-wrap">${escapeHtml(err.message ?? String(err))}</pre></div>`,
          );
          panel.setView(panelId, injected, ["db-run"]);
        }
      });
    } catch (err) {
      logger.error("sample db init failed:", err);
    }
  }

  logger.info("activated, recent files:", recentFiles.length);
}

export async function deactivate(ctx) {
  ctx.logger.info("deactivated");
}
