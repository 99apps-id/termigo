import { tool } from "ai";
import { z } from "zod";
import { saveCustomTool } from "../lib/customToolsIo";
import { slugifyToolName } from "../lib/customTools";
import { readSkillAt, searchSkills } from "../lib/skillSearchIo";
import {
  MAX_SKILL_BYTES,
  readSkill,
  saveSkill,
  slugifySkillName,
} from "../lib/skills";
import { checkSkillDependencies, dependencyWarning } from "../lib/skillDeps";
import type { ToolContext } from "./context";

export function buildSkillTools(
  ctx: ToolContext,
  availableTools: readonly string[] = [],
) {
  return {
    use_skill: tool({
      description:
        "Read a skill you wrote in an earlier session. The available skills and what each is for are listed in your system prompt — call this with a name from that list BEFORE working out your own approach, since the skill already contains one that worked. Read-only, so it runs without approval.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Skill name as listed in the prompt, or an absolute path to a SKILL.md returned by `find_skill`.",
          ),
      }),
      execute: async ({ name }) => {
        // A path rather than a name means it came from find_skill, which
        // reaches libraries outside the workspace. Reading by name alone would
        // make every found skill unreachable.
        const skill = name.includes("/") || name.includes("\\")
          ? await readSkillAt(name)
          : await readSkill(ctx.getWorkspaceRoot(), name);
        if (!skill) {
          // Not an error the model should retry: the name is either wrong or
          // the file is gone, and both are answered by picking another route.
          return { found: false, name, reason: "no skill by that name" };
        }
        // Checked against the live registry: a skill written for another agent
        // parses perfectly and can still be unfollowable here, and finding that
        // out by calling a tool that does not exist wastes a step and reads as
        // a Termigo fault.
        const warning = dependencyWarning(
          checkSkillDependencies(
            `${skill.description}
${skill.body}`,
            availableTools,
          ),
        );
        return {
          found: true,
          name: skill.name,
          description: skill.description,
          content: skill.body,
          ...(warning ? { warning } : {}),
        };
      },
    }),

    find_skill: tool({
      description:
        "Search every skill library on this machine — this workspace, your user-level skills, and those installed by other agent tools — for one matching a query. Use it when a task looks like something a skill would cover but nothing in your prompt matches. Returns names and descriptions; call `use_skill` with a returned path to read one. Read-only, so it runs without approval.",
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .describe("What the skill would be about, e.g. 'airtable' or 'deploy docker'."),
      }),
      execute: async ({ query }) => {
        try {
          const matches = await searchSkills(ctx.getWorkspaceRoot(), query);
          if (matches.length === 0) {
            return { query, count: 0, matches: [], hint: "no skill matched; proceed on your own" };
          }
          return {
            query,
            count: matches.length,
            matches: matches.map((m) => ({
              name: m.name,
              description: m.description,
              source: m.source,
              path: m.path,
            })),
          };
        } catch (e) {
          return { error: String(e), query };
        }
      },
    }),

    create_tool: tool({
      description:
        "Define a reusable shell command as a named tool, so a command worth repeating becomes something you can call by name instead of retyping. Use AFTER running a command that will recur with different arguments — a deploy script, a log tail, a migration runner. The command is a template with {{placeholders}}; every argument is shell-quoted when it runs, so a value can never become a second command. Stored in .termigo/tools.json. Re-using a name replaces that tool. Asks for approval.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("Short snake_case name, e.g. 'deploy_app'. Reuse a name to revise it."),
        description: z
          .string()
          .min(1)
          .describe("When to use it. This is what you will match against later."),
        command: z
          .string()
          .min(1)
          .describe(
            "Shell command with {{placeholders}}, e.g. './deploy.sh {{branch}}'. Do not quote the placeholders; that is done for you.",
          ),
        parameters: z
          .array(
            z.object({
              name: z.string().describe("Placeholder name, matching the command."),
              description: z.string().describe("What this argument is."),
              required: z.boolean().optional(),
            }),
          )
          .describe("One entry per placeholder. Every placeholder must be declared."),
      }),
      needsApproval: true,
      execute: async ({ name, description, command, parameters }) => {
        const slug = slugifyToolName(name);
        if (!slug) {
          return {
            saved: false,
            reason: `"${name}" cannot be turned into a tool name; use lowercase words separated by underscores`,
          };
        }
        const outcome = await saveCustomTool(ctx.getWorkspaceRoot(), {
          name: slug,
          description,
          command,
          parameters: parameters ?? [],
        });
        if (!outcome.saved) return { saved: false, reason: outcome.reason };
        return {
          saved: true,
          name: slug,
          tool_name: `cmd__${slug}`,
          replaced: outcome.replaced,
          total_tools: outcome.total,
          note: "available from your next message onward",
        };
      },
    }),

    create_skill: tool({
      description:
        "Save a reusable procedure so future sessions start from it instead of working it out again. Write one AFTER finishing something non-obvious that will recur: a deploy sequence, a debugging route that worked, a release checklist, the way this project's tooling actually behaves. Do NOT write one for a single-use task, for something you have not verified, or for facts — use `remember` for those. Re-saving an existing name replaces it, which is how a skill gets better with use. Asks for approval.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "Short kebab-case name, e.g. 'deploy-to-vps'. Reuse an existing name to improve that skill.",
          ),
        description: z
          .string()
          .min(1)
          .describe(
            "When to use this skill, phrased as a trigger: 'Use when deploying this project to the production VPS.' This is the only part the model sees until it opens the skill, so it has to be enough to choose by.",
          ),
        content: z
          .string()
          .min(1)
          .describe(
            "The procedure itself, in Markdown: the steps, the order, the commands, and the traps worth knowing. Write it for someone who has never done it.",
          ),
      }),
      needsApproval: true,
      execute: async ({ name, description, content }) => {
        // Accept a title as well as a slug: the model reaches for prose names,
        // and rejecting "Deploy to VPS" over punctuation would fail for a
        // reason that has nothing to do with the skill.
        const slug = slugifySkillName(name);
        if (!slug) {
          return {
            saved: false,
            reason: `"${name}" cannot be turned into a skill name; use lowercase words separated by hyphens`,
          };
        }
        const outcome = await saveSkill(ctx.getWorkspaceRoot(), {
          name: slug,
          description,
          body: content,
        });
        if (!outcome.saved) return { saved: false, reason: outcome.reason };
        return {
          saved: true,
          name: slug,
          path: outcome.path,
          replaced: outcome.replaced,
          limit_bytes: MAX_SKILL_BYTES,
        };
      },
    }),
  };
}
