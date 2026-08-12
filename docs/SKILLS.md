# Skills

Skills teach agents how to work in a project. A skill is a folder with a
`SKILL.md` file: YAML frontmatter (name + description) followed by Markdown
instructions. Helper scripts can sit next to the document.

```
<workspace>/.termigo/skills/
└── review/
    └── SKILL.md
```

`SKILL.md`:

```markdown
---
name: review
description: Review the current change set for correctness and style.
---

# Code review

Run `git status` and `git diff` first. Check:

1. Correctness - does the change behave as described?
2. Style - does it follow the project's formatting rules?
3. Tests - are new behaviors covered?

Report findings as a list with file references.
```

The `description` is what agents see when deciding whether to apply the skill;
keep it short (one sentence) and concrete. The `name` can be omitted and the
folder name is used instead.

## Scopes

| Scope   | Location                   | Use case |
| ---     | ---                        | --- |
| Project | `<workspace>/.termigo/skills/` | Conventions for one repository; committed and shared |
| User    | `~/.termigo/skills/`       | Personal workflows across all projects |

Project skills win on name conflicts.

## CLI usage

```powershell
termigo skill list              # list project + user skills (--json for machine output)
termigo skill show review       # print one skill's instructions
termigo skill create review "Review diffs before commit"
termigo skill create <name> <description> -w <project-dir>
```

## Agent integration

- Agents are told which skills exist and what each does (from the
  description), and can read the full `SKILL.md` on demand.
- `TERMIGO.md` at the workspace root is the project *memory*: conventions,
  build/test/lint commands, and things to be careful about. `termigo init`
  scaffolds it.
- Helper scripts are never executed automatically; an agent reads them and
  asks for approval before running anything.

## Writing good skills

- One job per skill. A skill that does "everything" is rarely applied.
- Put the trigger conditions in the description ("Use when...", "Run after...").
- Keep the body short; point at real files and commands instead of duplicating
  them.
- Add a `script.ps1` / `script.sh` / `script.py` only when the steps are
  mechanical and safe.
