# AI Prompt Library

Skeleton extension for Termigo that indexes `.termigo/commands/*.md` and exposes them through the sidebar, command palette, AI tools, and a detail panel.

## Install (dev)

```bash
cd extensions/ai-prompt-library
zip -r ../ai-prompt-library.zip .
```

Then in Termigo:
1. Open Settings → Extensions.
2. Install from file → choose `../ai-prompt-library.zip`.
3. Accept the requested permissions.

Or install from GitHub once published:

```
ext_install_from_github(owner="99apps-id", repo="termigo-ai-prompt-library", tag="0.1.0")
```

## What it demonstrates

- Reading workspace files via `invoke:fs_read_file`.
- Contributing a sidebar section with searchable rows.
- Registering commands (`/prompt:search`, `/prompt:open`, `/prompt:insert`).
- Registering AI tools (`search_prompts`, `use_prompt`).
- Contributing settings entries.
- Rendering a right-panel with `registerPanelRenderer`.

## Next steps

- Replace the naive `known = ["default.md"]` list with a directory walk.
- Store `usageCount` and `favorites` in `ctx.storage`.
- Add tag management UI.
- Support custom prompt directories beyond `.termigo/commands/`.
