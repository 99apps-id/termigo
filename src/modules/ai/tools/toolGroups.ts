// Optional tool domains, so a session does not pay for schemas it cannot use.
//
// The full toolset is ~125 tools and ~79 KB of JSON Schema (roughly 20k tokens)
// on EVERY request, before a word of the conversation. Measured per domain:
// browser automation 6.5 KB, git 6.0 KB, the two sub-agent spawners 5.6 KB,
// GitHub 2.7 KB, LSP 2.2 KB, and a long tail of SQL, PDF, image generation,
// worktrees and PTY driving. Nobody uses all of them in one session, and every
// schema not sent is budget the model spends on the request instead.
//
// Groups are explicit name lists rather than prefix patterns on purpose: a
// pattern would silently gate a tool added later that merely shares a prefix,
// while an explicit list means a rename shows up as a test failure instead.
//
// The core loop (files, shell, search, git, sub-agents, todos, verification) is
// deliberately NOT groupable. A toggle that can break basic coding is a foot
// gun, and those schemas are the ones worth paying for.

import { CORE_TOOL_NAMES } from "../agents/agentFactory";

export type ToolGroup = {
  id: string;
  label: string;
  /** One line for the settings UI: what turning this off costs the user. */
  description: string;
  tools: readonly string[];
};

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: "browser",
    label: "Browser automation",
    description:
      "Drive a headless browser: navigate, click, type, screenshot, read the page. Not needed for code work.",
    tools: [
      "browser_back",
      "browser_click",
      "browser_close",
      "browser_connect",
      "browser_console",
      "browser_download",
      "browser_extract",
      "browser_forward",
      "browser_hover",
      "browser_navigate",
      "browser_network",
      "browser_open",
      "browser_press",
      "browser_reload",
      "browser_session_click",
      "browser_session_click_at",
      "browser_session_click_item",
      "browser_session_close",
      "browser_session_composer",
      "browser_session_cookies",
      "browser_session_create",
      "browser_session_eval",
      "browser_session_list",
      "browser_session_navigate",
      "browser_session_resume",
      "browser_session_screenshot",
      "browser_session_select",
      "browser_session_text",
      "browser_session_type",
      "browser_session_wait",
      "browser_screenshot",
      "browser_scroll",
      "browser_select",
      "browser_snapshot",
      "browser_storage",
      "browser_type",
      "browser_upload",
      "browser_visual_diff",
      "browser_wait",
      "browser_wait_for",
    ],
  },
  {
    id: "github",
    label: "GitHub",
    description:
      "Open, review and merge pull requests through the GitHub API. Turn off if you use the CLI or another client.",
    tools: [
      "github_comment_pr",
      "github_create_pr",
      "github_get_pr",
      "github_list_prs",
      "github_merge_pr",
      "github_review_pr",
    ],
  },
  {
    id: "lsp",
    label: "Language servers",
    description:
      "Definitions, references, symbols, code actions, rename and diagnostics from a language server. Off means grep and reading instead.",
    tools: [
      "lsp_apply_code_action",
      "lsp_code_actions",
      "lsp_definitions",
      "lsp_diagnostics",
      "lsp_document_symbols",
      "lsp_references",
      "lsp_rename",
    ],
  },
  {
    id: "web",
    label: "Web access",
    description:
      "Search the web and fetch URLs. Off keeps the agent fully offline apart from your model provider.",
    tools: ["web_search", "web_fetch", "fetch"],
  },
  {
    id: "skills",
    label: "Skill authoring",
    description:
      "Create, install, update and browse reusable skills. Off keeps the agent from changing its own instructions.",
    tools: [
      "create_skill",
      "update_skill",
      "install_skill",
      "uninstall_skill",
      "use_skill",
      "find_skill",
      "search_skills",
      "suggest_skill",
      "review_suggested_skills",
      "promote_suggested_skill",
      "dismiss_suggested_skill",
    ],
  },
  {
    id: "self_improvement",
    label: "Self-improvement",
    description:
      "Record durable notes, learn preferences, summarise the user model, and author new tools.",
    tools: [
      "learn_fact",
      "learn_preference",
      "remember",
      "summarize_user_model",
      "create_tool",
    ],
  },
  {
    id: "workflow",
    label: "Workflows and policies",
    description:
      "Named multi-step workflows, orchestrator dispatch, plan mode and policy listing.",
    tools: [
      "list_workflows",
      "run_workflow",
      "list_pipelines",
      "list_policies",
      "orchestrate",
      "plan_mode",
    ],
  },
  {
    id: "harness",
    label: "Invariant ledger",
    description:
      "Record and list project invariants that the agent must not break.",
    tools: ["list_invariants", "pin_invariant", "unpin_invariant"],
  },
  {
    id: "preview",
    label: "Previews and dev servers",
    description:
      "Open preview tabs and canvases, render HTML, and start or stop dev servers.",
    tools: ["open_preview", "render_view", "preview_file", "dev_server"],
  },
  {
    id: "handoff",
    label: "Coding-agent handoff",
    description:
      "Spawn an external coding agent in a terminal tab and read its output.",
    tools: ["spawn_coding_agent", "read_agent_output", "send_to_agent"],
  },
  {
    id: "pty_driver",
    label: "Interactive terminal driving",
    description:
      "Drive a full-screen TUI programmatically: read the screen, send keys, wait for a pattern.",
    tools: [
      "pty_read_screen",
      "pty_send_input",
      "pty_session",
      "pty_wait_for_pattern",
    ],
  },
  {
    id: "worktree",
    label: "Git worktrees",
    description:
      "Create and discard parallel worktrees for isolated experiments.",
    tools: ["worktree_create", "worktree_discard", "worktree_list"],
  },
  {
    id: "sql",
    label: "SQL explorer",
    description:
      "Run queries against a configured database CLI and list saved connections.",
    tools: [
      "run_sql",
      "list_sql_connections",
      "sql_schema",
      "sql_explain",
      "sql_health",
    ],
  },
  {
    id: "filesystem_advanced",
    label: "Advanced filesystem",
    description:
      "Inspect links and permissions, or create links and change Unix modes.",
    tools: ["readlink", "file_permissions", "symlink", "chmod"],
  },
  {
    id: "git_metadata",
    label: "Git metadata",
    description:
      "Read tags, remotes, stashes and worktrees through structured Git APIs.",
    tools: ["git_tags", "git_remotes", "git_stashes", "git_worktrees"],
  },
  {
    id: "documents",
    label: "PDF reading",
    description: "Extract text from PDF files.",
    tools: ["read_pdf"],
  },
  {
    id: "office",
    label: "Office documents",
    description:
      "Create and read Word, Excel, PowerPoint, PDF and iCalendar files. Turn off if you never produce office deliverables.",
    tools: [
      "calendar_read_ics",
      "calendar_write",
      "csv_analyze",
      "csv_write",
      "docx_create",
      "docx_read",
      "excel_read",
      "excel_write",
      "pdf_create",
      "pptx_create",
      "pptx_read",
    ],
  },
  {
    id: "history",
    label: "Command history search",
    description: "Search and clear the shell history index.",
    tools: ["search_history", "clear_history_index"],
  },
  {
    id: "compare",
    label: "Tree comparison",
    description:
      "Compare two checkouts by file manifest: what a fork adds, drops or changed against its reference. Off leaves you with git diff.",
    tools: ["compare_trees"],
  },
  {
    id: "telegram",
    label: "Telegram relay",
    description:
      "Send a file, photo, voice note, or message to your paired Telegram chat, so a long run can report to you while you are away from the desk.",
    tools: [
      "telegram_send_document",
      "telegram_send_message",
      "telegram_send_photo",
      "telegram_send_voice",
    ],
  },
  {
    id: "media",
    label: "OCR, image generation and TTS",
    description:
      "Extract text from images and scanned PDFs (OCR), generate images, and synthesize speech / Telegram voice notes.",
    tools: ["ocr_extract", "generate_image", "text_to_speech"],
  },
  {
    id: "cron",
    label: "Automation and cron jobs",
    description:
      "Create, list, toggle and delete scheduled recurring automation / cron jobs.",
    tools: ["cron_list", "cron_create", "cron_toggle", "cron_delete"],
  },
  {
    id: "pentest",
    label: "Security assessment & pentest",
    description:
      "Authorized scope check, passive HTTP security headers and TLS auditing, CVSS v3.1 scoring, structured finding ledger, and client-ready Markdown report generation.",
    tools: [
      "pentest_scope_status",
      "security_headers_audit",
      "tls_audit",
      "cvss_calculate",
      "pentest_finding_log",
      "pentest_report_generate",
    ],
  },
  {
    id: "desktop",
    label: "Desktop apps & Blender",
    description:
      "Launch and focus desktop applications (Blender, GIMP, LibreOffice, browsers), take desktop screenshots, send GUI input, and run Python (bpy) scripts inside Blender.",
    tools: [
      "desktop_launch_app",
      "desktop_list_windows",
      "desktop_focus_window",
      "desktop_screenshot",
      "desktop_input",
      "blender_run_python",
    ],
  },
  {
    id: "utility",
    label: "Utility",
    description:
      "Quick helpers: hashing, encoding, JWT inspection, secret pattern scan, and archive create/extract.",
    tools: [
      "http_request",
      "jwt_inspect",
      "secret_scan",
      "hash_calc",
      "archive_tool",
      "encoding_tool",
    ],
  },
];

/** Every tool name that appears in some group. */
export function groupedToolNames(): Set<string> {
  return new Set(TOOL_GROUPS.flatMap((g) => g.tools));
}

/**
 * Remove the tools of the disabled groups.
 *
 * Unknown ids are ignored so a preference written by a newer build cannot make
 * the toolset vanish, and the core tools are never removed even if a group
 * listed one by mistake (a test also asserts that cannot happen).
 */
export function applyDisabledToolGroups<T>(
  tools: Record<string, T>,
  disabled: readonly string[],
): Record<string, T> {
  if (disabled.length === 0) return tools;
  const disabledIds = new Set(disabled);
  const drop = new Set<string>();
  for (const group of TOOL_GROUPS) {
    if (!disabledIds.has(group.id)) continue;
    for (const name of group.tools) {
      if (CORE_TOOL_NAMES.has(name)) continue;
      drop.add(name);
    }
  }
  if (drop.size === 0) return tools;
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => !drop.has(name)),
  );
}

/** Group ids that exist, for validating a stored preference. */
export function isToolGroupId(id: string): boolean {
  return TOOL_GROUPS.some((g) => g.id === id);
}

/**
 * What each group costs in the measured payload, for the settings UI.
 *
 * Computed from the real toolset rather than a static table so the number a
 * user sees before toggling is the number they will save. `bytes` counts only
 * the group's tools that are actually present, so a group already missing its
 * tools reports zero rather than promising a saving it cannot deliver.
 */
export function groupUsage(
  byTool: readonly { name: string; bytes: number }[],
): { group: ToolGroup; present: number; bytes: number }[] {
  const bytesByName = new Map(byTool.map((t) => [t.name, t.bytes]));
  return TOOL_GROUPS.map((group) => {
    let bytes = 0;
    let present = 0;
    for (const name of group.tools) {
      const b = bytesByName.get(name);
      if (b === undefined) continue;
      present += 1;
      bytes += b;
    }
    return { group, present, bytes };
  }).sort((a, b) => b.bytes - a.bytes);
}
