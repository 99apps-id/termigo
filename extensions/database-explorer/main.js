/**
 * Database Explorer — Termigo extension skeleton
 *
 * Demonstrates:
 *  - sidebar section for databases / schemas / tables
 *  - panel renderer for query editor + results grid
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
  // 1. State
  // ------------------------------------------------------------------
  let recentFiles = [];
  let activeDb = null; // { path, name, tables: [] }
  let panelOpen = false;

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
  // 2. Sidebar section
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
      onItemClick: (itemId) => {
        const path = itemId.slice(3); // strip "db:"
        openDatabase(path);
      },
    });
  }

  // ------------------------------------------------------------------
  // 3. Database open / describe (skeleton)
  // ------------------------------------------------------------------
  async function openDatabase(path) {
    try {
      // In a real extension we'd read the SQLite header + schema via sql.js.
      // For the skeleton we fake a successful open so the panel has something
      // to render.
      touchRecent(path);
      activeDb = {
        path,
        name: path.split(/[\\/]/).pop() || path,
        tables: [
          { name: "users", rows: 128 },
          { name: "orders", rows: 1024 },
        ],
      };
      openQueryPanel();
    } catch (err) {
      logger.error("openDatabase failed:", err);
      ctx.ui.toast(`Failed to open database: ${err.message}`);
    }
  }

  async function describeDatabase(path) {
    // Placeholder: real implementation uses sql.js to read sqlite_master.
    return {
      path,
      tables: activeDb?.tables ?? [],
    };
  }

  async function runQuery(path, sql) {
    // Placeholder: real implementation uses sql.js to exec + return columns/rows.
    return {
      columns: ["id", "name"],
      rows: [
        [1, "Alice"],
        [2, "Bob"],
      ],
      rowCount: 2,
    };
  }

  // ------------------------------------------------------------------
  // 4. Panel (query editor + results)
  // ------------------------------------------------------------------
  function openQueryPanel() {
    const panelId = "db-query";
    tabs.openExtensionTab({
      panelId,
      title: activeDb ? activeDb.name : "Database",
      reuseKey: activeDb?.path ?? "db-query",
    });
    panelOpen = true;
  }

  const renderPanel = (container, opts) => {
    const db = activeDb;
    container.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.style.padding = "12px";
    wrap.style.fontFamily = "system-ui, sans-serif";

    if (!db) {
      wrap.textContent = "Open a SQLite file from the sidebar.";
      container.appendChild(wrap);
      return () => {};
    }

    const header = document.createElement("h3");
    header.textContent = db.name;
    header.style.margin = "0 0 8px";

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.7";
    meta.style.marginBottom = "12px";
    meta.textContent = db.path;

    const tablesLabel = document.createElement("div");
    tablesLabel.textContent = "Tables";
    tablesLabel.style.fontWeight = "600";
    tablesLabel.style.marginBottom = "6px";

    const tableList = document.createElement("div");
    tableList.style.display = "flex";
    tableList.style.flexDirection = "column";
    tableList.style.gap = "4px";
    tableList.style.marginBottom = "12px";

    for (const t of db.tables ?? []) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.padding = "4px 8px";
      row.style.background = "rgba(127,127,127,0.08)";
      row.style.borderRadius = "4px";
      row.style.fontSize = "13px";

      const name = document.createElement("span");
      name.textContent = t.name;

      const count = document.createElement("span");
      count.style.opacity = "0.7";
      count.textContent = `${t.rows} rows`;

      row.append(name, count);
      tableList.appendChild(row);
    }

    const sqlLabel = document.createElement("label");
    sqlLabel.textContent = "SQL";
    sqlLabel.style.fontWeight = "600";
    sqlLabel.style.display = "block";
    sqlLabel.style.marginBottom = "6px";

    const sqlInput = document.createElement("textarea");
    sqlInput.placeholder = "SELECT * FROM users LIMIT 100;";
    sqlInput.style.width = "100%";
    sqlInput.style.minHeight = "90px";
    sqlInput.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", monospace";
    sqlInput.style.fontSize = "13px";
    sqlInput.style.padding = "8px";
    sqlInput.style.borderRadius = "6px";
    sqlInput.style.border = "1px solid rgba(127,127,127,0.25)";
    sqlInput.style.background = "transparent";
    sqlInput.style.color = "inherit";
    sqlInput.style.resize = "vertical";

    const runBtn = document.createElement("button");
    runBtn.textContent = "Run query";
    runBtn.style.marginTop = "8px";
    runBtn.style.padding = "6px 12px";
    runBtn.style.borderRadius = "6px";
    runBtn.style.border = "1px solid rgba(127,127,127,0.3)";
    runBtn.style.background = "transparent";
    runBtn.style.color = "inherit";
    runBtn.style.cursor = "pointer";

    const results = document.createElement("div");
    results.style.marginTop = "12px";

    runBtn.onclick = async () => {
      const sql = sqlInput.value.trim();
      if (!sql) {
        ctx.ui.toast("Enter a SQL query first.");
        return;
      }
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      try {
        const res = await runQuery(db.path, sql);
        results.innerHTML = "";

        const count = document.createElement("div");
        count.style.fontSize = "12px";
        count.style.opacity = "0.8";
        count.style.marginBottom = "6px";
        count.textContent = `${res.rowCount} row${res.rowCount === 1 ? "" : "s"}`;
        results.appendChild(count);

        const grid = document.createElement("div");
        grid.style.overflow = "auto";
        grid.style.maxHeight = "40vh";
        grid.style.borderRadius = "6px";
        grid.style.border = "1px solid rgba(127,127,127,0.2)";

        const table = document.createElement("table");
        table.style.width = "100%";
        table.style.borderCollapse = "collapse";
        table.style.fontSize = "13px";

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const col of res.columns) {
          const th = document.createElement("th");
          th.textContent = col;
          th.style.textAlign = "left";
          th.style.padding = "6px 8px";
          th.style.borderBottom = "1px solid rgba(127,127,127,0.25)";
          th.style.background = "rgba(127,127,127,0.08)";
          th.style.position = "sticky";
          th.style.top = "0";
          headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (const row of res.rows) {
          const tr = document.createElement("tr");
          for (const cell of row) {
            const td = document.createElement("td");
            td.textContent = cell === null ? "NULL" : String(cell);
            td.style.padding = "5px 8px";
            td.style.borderBottom = "1px solid rgba(127,127,127,0.1)";
            td.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        grid.appendChild(table);
        results.appendChild(grid);
      } catch (err) {
        logger.error("runQuery failed:", err);
        results.innerHTML = `<pre style="color:#ff8a8a;margin:0;">${err.message}</pre>`;
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "Run query";
      }
    };

    wrap.append(header, meta, tablesLabel, tableList, sqlLabel, sqlInput, runBtn, results);
    container.appendChild(wrap);

    return () => {};
  };

  ctx.registerPanelRenderer("db-query", renderPanel);

  // ------------------------------------------------------------------
  // 5. Commands
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
    // Placeholder: in a real extension this would open a file picker or
    // accept a path argument.
    ctx.ui.toast("Open a .db file from the sidebar (skeleton)");
  });

  registerCommandHandler("db:describe", async () => {
    if (!activeDb) {
      ctx.ui.toast("No active database. Open one from the sidebar.");
      return;
    }
    const desc = await describeDatabase(activeDb.path);
    const summary = desc.tables.map((t) => `${t.name} (${t.rows} rows)`).join(", ");
    ctx.ui.toast(summary || "No tables found.");
  });

  registerCommandHandler("db:export", async () => {
    ctx.ui.toast("Export to CSV (skeleton)");
  });

  // ------------------------------------------------------------------
  // 6. AI tools
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
    return describeDatabase(path);
  });

  registerAiToolHandler("db_query", async (args) => {
    const path = String(args?.path ?? "");
    const sql = String(args?.sql ?? "");
    if (!path || !sql) return { error: "path and sql are required" };
    // Safety: only allow reads in the skeleton.
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
      return { error: "Only SELECT queries are allowed in this extension." };
    }
    return runQuery(path, sql);
  });

  // ------------------------------------------------------------------
  // 7. Settings
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
  // 8. Init
  // ------------------------------------------------------------------
  await loadRecentFiles();
  renderSidebar();
  logger.info("activated, recent files:", recentFiles.length);
}

export async function deactivate(ctx) {
  ctx.logger.info("deactivated");
}
