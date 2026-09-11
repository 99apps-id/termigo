import { tool } from "ai";
import { z } from "zod";
import {
  type LearnedFact,
  type Preference,
  getOrCreateUserModel,
  saveUserModel,
} from "../lib/userModel";
import { saveSkill, type Skill } from "../lib/skills";

const MAX_PREFERENCES = 40;
const MAX_FACTS = 120;

export type PreferenceInput = {
  key: string;
  label: string;
  value: string;
  source?: "session" | "explicit" | "inferred";
};

export type FactInput = {
  text: string;
  category?: string;
  source?: "session" | "explicit" | "inferred";
};

function nextId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function buildSelfImprovementTools() {
  return {
    learn_preference: tool({
      description:
        "Record a learned user preference for self-improvement. Use this when the user consistently expresses a formatting, tool, workflow, or behavior preference.",
      inputSchema: z.object({
        key: z.string().min(1).describe("Machine-readable preference key."),
        label: z.string().min(1).describe("Human-readable label."),
        value: z.string().min(1).describe("Inferred preference value."),
      }),
      execute: async ({ key, label, value }: { key: string; label: string; value: string }) => {
        const model = await getOrCreateUserModel();
        const existingIndex = model.preferences.findIndex((p) => p.key === key);
        const entry: Preference = {
          key,
          label,
          value,
          confidence: existingIndex >= 0 ? model.preferences[existingIndex].confidence + 0.1 : 0.5,
          observations: existingIndex >= 0 ? model.preferences[existingIndex].observations + 1 : 1,
          updatedAt: new Date().toISOString().slice(0, 10),
          approved: null,
        };
        if (existingIndex >= 0) {
          model.preferences[existingIndex] = entry;
        } else {
          model.preferences.push(entry);
          while (model.preferences.length > MAX_PREFERENCES) model.preferences.shift();
        }
        await saveUserModel(model);
        return {
          ok: true,
          preference: entry,
          totalPreferences: model.preferences.length,
        };
      },
    }),

    learn_fact: tool({
      description:
        "Record a durable learned fact about the user, workspace, or workflow. Use this for stable knowledge worth remembering across sessions.",
      inputSchema: z.object({
        text: z.string().min(1).describe("The fact to remember."),
        category: z.string().optional().describe("Optional category."),
      }),
      execute: async ({ text, category }: { text: string; category?: string }) => {
        const model = await getOrCreateUserModel();
        const fact: LearnedFact = {
          id: nextId(),
          text,
          category,
          source: "inferred",
          date: new Date().toISOString().slice(0, 10),
          weight: 1,
        };
        model.facts.push(fact);
        while (model.facts.length > MAX_FACTS) model.facts.shift();
        await saveUserModel(model);
        return {
          ok: true,
          fact,
          totalFacts: model.facts.length,
        };
      },
    }),

    suggest_skill: tool({
      description:
        "Suggest a reusable Termigo skill from current session patterns. Use this when the same workflow repeats and would benefit from a saved skill.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Suggested skill name."),
        reason: z.string().min(1).describe("Why this skill would help."),
      }),
      execute: async ({ name, reason }: { name: string; reason: string }) => {
        const model = await getOrCreateUserModel();
        const trimmed = name.trim();
        if (!model.suggestedSkills.includes(trimmed)) {
          model.suggestedSkills.push(trimmed);
          while (model.suggestedSkills.length > 50) model.suggestedSkills.shift();
        }
        model.suggestedSkillCounts = model.suggestedSkillCounts ?? {};
        const next = (model.suggestedSkillCounts[trimmed] ?? 0) + 1;
        model.suggestedSkillCounts[trimmed] = next;
        await saveUserModel(model);
        return {
          ok: true,
          suggestion: { name: trimmed, reason },
          count: next,
          suggestedSkills: model.suggestedSkills,
          next: "Use review_suggested_skills to inspect candidates before promotion.",
        };
      },
    }),

    promote_suggested_skill: tool({
      description:
        "Turn a suggested skill into a real SKILL.md under .termigo/skills. Use this only after the user approved the idea or it clearly recurred across sessions.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Skill name to create or replace."),
        description: z.string().min(1).describe("When to use this skill."),
        body: z.string().min(1).describe("Skill procedure/markdown body."),
      }),
      execute: async ({ name, description, body }: { name: string; description: string; body: string }) => {
        const model = await getOrCreateUserModel();
        const skill: Skill = {
          name,
          description: description.slice(0, 300),
          body: body.trim().slice(0, 16 * 1024),
        };
        const outcome = await saveSkill(null, skill);
        if (!outcome.saved) {
          return { ok: false, reason: outcome.reason };
        }
        const idx = model.suggestedSkills.indexOf(name);
        if (idx >= 0) {
          model.suggestedSkills.splice(idx, 1);
          await saveUserModel(model);
        }
        return {
          ok: true,
          path: outcome.path,
          replaced: outcome.replaced,
          suggestedSkills: model.suggestedSkills,
        };
      },
    }),

    dismiss_suggested_skill: tool({
      description:
        "Remove a suggested skill without creating it. Use this when the suggestion is irrelevant, outdated, or too broad.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Suggested skill name to remove."),
      }),
      execute: async ({ name }: { name: string }) => {
        const model = await getOrCreateUserModel();
        const idx = model.suggestedSkills.indexOf(name);
        const removed = idx >= 0;
        if (removed) {
          model.suggestedSkills.splice(idx, 1);
          await saveUserModel(model);
        }
        return { ok: true, removed, suggestedSkills: model.suggestedSkills };
      },
    }),

    summarize_user_model: tool({
      description:
        "Summarize current learned preferences, facts, and skill suggestions for the user.",
      inputSchema: z.object({}),
      execute: async () => {
        const model = await getOrCreateUserModel();
        return {
          ok: true,
          preferences: model.preferences.length,
          facts: model.facts.length,
          patterns: model.patterns.length,
          suggestedSkills: model.suggestedSkills.length,
          suggestedSkillCounts: Object.entries(model.suggestedSkillCounts ?? {}).slice(-12),
          topPreferences: model.preferences.slice(-8),
          recentFacts: model.facts.slice(-10),
        };
      },
    }),

    review_suggested_skills: tool({
      description:
        "Review suggested skills sorted by suggestion count. Use this before promote_suggested_skill to pick candidates with real repetition.",
      inputSchema: z.object({}),
      execute: async () => {
        const model = await getOrCreateUserModel();
        const counts = model.suggestedSkillCounts ?? {};
        const ranked = model.suggestedSkills
          .map((name) => ({ name, count: counts[name] ?? 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);
        return {
          ok: true,
          ranked,
          total: model.suggestedSkills.length,
        };
      },
    }),
  };
}
