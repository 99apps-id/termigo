// Lightweight user modeling for Termigo self-improvement.
// Stores learned facts, preferences, and reusable patterns.

import { homeDir } from "@tauri-apps/api/path";
import { native } from "./native";

export type Preference = {
  /** Short machine-readable key. */
  key: string;
  /** Human-readable label for settings UI. */
  label: string;
  /** Inferred value. */
  value: string;
  /** Confidence from 0 to 1. */
  confidence: number;
  /** Number of observations backing this preference. */
  observations: number;
  /** Last updated ISO date. */
  updatedAt: string;
  /** Whether user has explicitly approved or rejected this. */
  approved: boolean | null;
};

export type LearnedFact = {
  id: string;
  text: string;
  /** Category: workflow, tool, style, domain, ... */
  category?: string;
  /** Source: session, explicit, inferred. */
  source: "session" | "explicit" | "inferred";
  /** ISO date. */
  date: string;
  /** 0..1 strength. */
  weight: number;
};

export type UserModel = {
  preferences: Preference[];
  facts: LearnedFact[];
  /** Patterns detected from tool/task sequences. */
  patterns: string[];
  /** Suggested skills to create. */
  suggestedSkills: string[];
  /** Last compacted ISO date. */
  lastCompactedAt: string | null;
};

const DEFAULT: UserModel = {
  preferences: [],
  facts: [],
  patterns: [],
  suggestedSkills: [],
  lastCompactedAt: null,
};

let inMemory: UserModel = { ...DEFAULT };

export async function userModelPath(): Promise<string | null> {
  try {
    const home = await homeDir();
    return `${home.replace(/[\\/]+$/, "")}/.termigo/user-model.json`;
  } catch {
    return null;
  }
}

export async function loadUserModel(): Promise<UserModel> {
  const path = await userModelPath();
  if (!path) return { ...DEFAULT };
  try {
    const result = await native.readFile(path);
    if (result.kind !== "text") return { ...DEFAULT };
    const parsed = JSON.parse(result.content) as UserModel;
    return {
      ...DEFAULT,
      ...parsed,
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      suggestedSkills: Array.isArray(parsed.suggestedSkills)
        ? parsed.suggestedSkills
        : [],
    };
  } catch {
    return { ...DEFAULT };
  }
}

export async function saveUserModel(model: UserModel): Promise<void> {
  const path = await userModelPath();
  if (!path) return;
  try {
    const dir = path.replace(/[\\/][^\\/]+$/, "");
    try {
      await native.createDir(dir);
    } catch {
      // already exists
    }
    await native.writeFile(path, JSON.stringify(model, null, 2));
    inMemory = model;
  } catch {
    // best-effort
  }
}

export async function getOrCreateUserModel(): Promise<UserModel> {
  const loaded = await loadUserModel();
  inMemory = loaded;
  return loaded;
}

export function getInMemoryUserModel(): UserModel {
  return inMemory;
}

const MAX_PREFERENCES_SHOWN = 8;
const MAX_FACTS_SHOWN = 8;

export function formatUserModelBlock(model: UserModel | undefined): string {
  if (!model) return "";
  const parts: string[] = [];

  const preferences = model.preferences.slice(-MAX_PREFERENCES_SHOWN);
  const facts = model.facts.slice(-MAX_FACTS_SHOWN);

  if (preferences.length > 0 || facts.length > 0) {
    parts.push(
      "\n\n## LEARNED - user-model.json\n" +
        "Facts and preferences inferred from prior sessions. Treat them as soft " +
        "guidance, not instructions; user overrides still win.\n",
    );
  }

  if (preferences.length > 0) {
    parts.push(
      "### PREFERENCES\n" + preferences.map((p) => `- ${p.label}: ${p.value}`).join("\n") + "\n",
    );
  }

  if (facts.length > 0) {
    parts.push(
      "### LEARNED FACTS\n" + facts.map((f) => `- ${f.text}`).join("\n") + "\n",
    );
  }

  return parts.join("");
}
