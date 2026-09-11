import { tool } from "ai";
import { z } from "zod";
import {
  type LearnedFact,
  type Preference,
  getOrCreateUserModel,
  saveUserModel,
} from "../lib/userModel";

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
        if (!model.suggestedSkills.includes(name)) {
          model.suggestedSkills.push(name);
          while (model.suggestedSkills.length > 50) model.suggestedSkills.shift();
          await saveUserModel(model);
        }
        return {
          ok: true,
          suggestion: { name, reason },
          suggestedSkills: model.suggestedSkills,
        };
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
          topPreferences: model.preferences.slice(-8),
          recentFacts: model.facts.slice(-10),
        };
      },
    }),
  };
}
