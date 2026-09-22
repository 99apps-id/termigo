/**
 * AI Prompt Library — Termigo extension skeleton
 *
 * Demonstrates:
 *  - reading .termigo/commands/*.md via fs_read_file
 *  - sidebar section (prompt list + search)
 *  - commands (/prompt:search, /prompt:insert, /prompt:open)
 *  - AI tools (search_prompts, use_prompt)
 *  - settings (default category, search pref)
 *  - panel (prompt detail / editor)
 */

export async function activate(ctx) {
  const { contribute, settings, sidebar, commands, tabs, panel, registerAiToolHandler, registerCommandHandler, logger, storage } = ctx;

  // ------------------------------------------------------------------
  // 1. Index built-in prompts from .termigo/commands/*.md
  // ------------------------------------------------------------------
  async function readBuiltInCommands() {
    try {
      const ctxSnapshot = ctx.app.getContext();
      const rootDir = ctxSnapshot.workspaceCwd
        ? `${ctxSnapshot.workspaceCwd}/.termigo/commands`
        : `${ctx.paths.home}/.termigo/commands`;
      // We don't have a directory listing command, so we use a fixed set of
      // well-known command files. Extensions can also index their own folder.
      const known = ["default.md"];
      const prompts = [];

      for (const name of known) {
        try {
          const result = await ctx.invoke("fs_read_file", {
            path: `${rootDir}/${name}`,
          });
          if (result && result.kind === "text") {
            // Very naive parser: first H1 = title, rest = body
            const lines = result.content.split("\n");
            const titleLine = lines.find((l) => l.startsWith("# "));
            prompts.push({
              id: `builtin:${name}`,
              title: titleLine ? titleLine.slice(2).trim() : name,
              body: result.content,
              source: "builtin",
              tags: [],
              usageCount: 0,
            });
          }
        } catch (err) {
          logger.warn(`failed to read ${name}:`, err);
        }
      }

      return prompts;
    } catch (err) {
      logger.error("indexing built-in prompts failed:", err);
      return [];
    }
  }

  // ------------------------------------------------------------------
  // 2. State
  // ------------------------------------------------------------------
  let prompts = [];
  let panelOpen = false;

  async function refreshPrompts() {
    prompts = await readBuiltInCommands();
    renderSidebar();
  }

  // ------------------------------------------------------------------
  // 3. Sidebar section
  // ------------------------------------------------------------------
  function renderSidebar() {
    sidebar.setSection({
      id: "ai-prompt-library",
      title: "Prompts",
      items: prompts.map((p) => ({
        id: p.id,
        label: p.title,
        subtitle: p.source === "builtin" ? "Built-in" : "Custom",
        badge: p.tags[0] || null,
        onClick: () => openPromptPanel(p.id),
      })),
    });
  }

  // ------------------------------------------------------------------
  // 4. Panel (prompt detail / editor)
  // ------------------------------------------------------------------
  function openPromptPanel(promptId) {
    const prompt = prompts.find((p) => p.id === promptId);
    if (!prompt) return;

    const panelId = "prompt-detail";
    tabs.openExtensionTab({
      panelId,
      title: prompt.title,
      reuseKey: promptId,
    });
    panelOpen = true;
  }

  // Panel renderer
  const renderPanel = (container, opts) => {
    const promptId = opts?.reuseKey;
    const prompt = prompts.find((p) => p.id === promptId);

    container.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.style.padding = "12px";
    wrap.style.fontFamily = "system-ui, sans-serif";

    if (!prompt) {
      wrap.textContent = "Prompt not found.";
      container.appendChild(wrap);
      return () => {};
    }

    const title = document.createElement("h3");
    title.textContent = prompt.title;
    title.style.margin = "0 0 8px";

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.7";
    meta.style.marginBottom = "12px";
    meta.textContent = `${prompt.source} · ${prompt.tags.join(", ") || "no tags"}`;

    const body = document.createElement("pre");
    body.textContent = prompt.body;
    body.style.whiteSpace = "pre-wrap";
    body.style.background = "rgba(127,127,127,0.1)";
    body.style.padding = "8px";
    body.style.borderRadius = "6px";
    body.style.overflow = "auto";
    body.style.maxHeight = "60vh";

    const insertBtn = document.createElement("button");
    insertBtn.textContent = "Insert into composer";
    insertBtn.style.marginTop = "12px";
    insertBtn.onclick = () => {
      // In a real extension we'd insert into the active editor or AI composer.
      // For the skeleton we just toast.
      ctx.ui.toast(`Prompt "${prompt.title}" inserted (placeholder)`);
    };

    wrap.append(title, meta, body, insertBtn);
    container.appendChild(wrap);

    return () => {
      // cleanup
    };
  };

  ctx.registerPanelRenderer("prompt-detail", renderPanel);

  // ------------------------------------------------------------------
  // 5. Commands
  // ------------------------------------------------------------------
  contribute.commands([
    {
      id: "prompt:search",
      title: "Prompt Library: Search prompts",
      subtitle: "Search indexed prompts by keyword or tag",
    },
    {
      id: "prompt:insert",
      title: "Prompt Library: Insert last used",
      subtitle: "Insert the most recently used prompt",
    },
    {
      id: "prompt:open",
      title: "Prompt Library: Open selected",
      subtitle: "Open the selected prompt in a panel",
    },
  ]);

  registerCommandHandler("prompt:search", () => {
    // Placeholder: in a real extension this would open a quick-pick or
    // filter the sidebar section.
    ctx.ui.toast("Prompt search: type in the sidebar to filter (skeleton)");
  });

  registerCommandHandler("prompt:insert", () => {
    ctx.ui.toast("Inserted last used prompt (skeleton)");
  });

  registerCommandHandler("prompt:open", () => {
    if (prompts.length > 0) {
      openPromptPanel(prompts[0].id);
    } else {
      ctx.ui.toast("No prompts indexed yet.");
    }
  });

  // ------------------------------------------------------------------
  // 6. AI tools
  // ------------------------------------------------------------------
  contribute.aiTools([
    {
      name: "search_prompts",
      description: "Search the user's prompt library by keyword or tag.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          tag: { type: "string", description: "Filter by tag" },
        },
        required: ["query"],
      },
    },
    {
      name: "use_prompt",
      description: "Retrieve a prompt by id or title and return its body.",
      parameters: {
        type: "object",
        properties: {
          promptId: { type: "string", description: "Prompt id or title" },
        },
        required: ["promptId"],
      },
    },
  ]);

  registerAiToolHandler("search_prompts", async (args) => {
    const q = String(args?.query ?? "").toLowerCase();
    const tag = String(args?.tag ?? "").toLowerCase();
    const matches = prompts.filter((p) => {
      const hit = !q || p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q);
      const tagOk = !tag || (p.tags || []).some((t) => t.toLowerCase().includes(tag));
      return hit && tagOk;
    });
    return matches.map((p) => ({ id: p.id, title: p.title, tags: p.tags }));
  });

  registerAiToolHandler("use_prompt", async (args) => {
    const idOrTitle = String(args?.promptId ?? "");
    const prompt = prompts.find((p) => p.id === idOrTitle || p.title.toLowerCase() === idOrTitle.toLowerCase());
    if (!prompt) return { error: "prompt not found" };
    return { id: prompt.id, title: prompt.title, body: prompt.body };
  });

  // ------------------------------------------------------------------
  // 7. Settings
  // ------------------------------------------------------------------
  contribute.settings([
    {
      key: "defaultCategory",
      title: "Default prompt category",
      description: "Category selected when opening the prompt library.",
      type: "string",
      default: "all",
    },
    {
      key: "searchPref",
      title: "Search preference",
      description: "Prefer keyword or tag search by default.",
      type: "string",
      default: "keyword",
    },
  ]);

  // ------------------------------------------------------------------
  // 8. Init
  // ------------------------------------------------------------------
  await refreshPrompts();

  // Re-index when workspace context changes (naive: re-read every time).
  // A real extension would diff the file list.
  const unsub = ctx.app.onContextChange(() => {
    void refreshPrompts();
  });
  ctx.addDisposer(unsub);

  logger.info("activated, indexed", prompts.length, "prompts");
}

export async function deactivate(ctx) {
  ctx.logger.info("deactivated");
}
