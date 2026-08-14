import { tool } from "ai";
import { z } from "zod";
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
        name: z.string().describe("Skill name, exactly as listed in the prompt."),
      }),
      execute: async ({ name }) => {
        const skill = await readSkill(ctx.getWorkspaceRoot(), name);
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
