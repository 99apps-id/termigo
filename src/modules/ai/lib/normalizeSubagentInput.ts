import { repairJsonText } from "./repairToolCall";

export function parseJsonIfString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(repairJsonText(trimmed));
    } catch {
      return value;
    }
  }
}

/**
 * Normalise the model's tool input for `run_subagents` into `{ tasks[],
 * max_concurrency? }`.
 *
 * Models often emit:
 * - the whole tool call as a JSON string
 * - `tasks` under another name like `todos`, `subagents`, `agents`, `jobs`, `items`, `plan`, `steps`, `list`
 * - `tasks` / `todos` as a stringified JSON array
 * - individual tasks without `prompt`, using `title`, `task`, `instruction`, or `description`
 * - individual tasks without `type`, using `role`, `agent`, or `id`
 * - string dependencies or id-based dependencies (`depends_on: ["map"]` or `"0"`)
 * - a bare array of tasks directly as the tool input
 */
export function normalizeBatchInput(input: unknown): unknown {
  let value = input;
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    const parsed = parseJsonIfString(value);
    if (parsed === value) break;
    value = parsed;
  }

  if (!value) return value;

  // If the model emitted a bare array of tasks, wrap it in `{ tasks }`.
  if (Array.isArray(value)) {
    value = { tasks: value };
  }

  if (typeof value !== "object") return value;

  const obj = { ...(value as Record<string, unknown>) };

  // Models often call the task list `todos`, `subagents`, `agents`, `jobs`, `items`, `plan`, `steps`, or `list`.
  const rawTasksCandidate =
    obj.tasks ??
    obj.todos ??
    obj.subagents ??
    obj.agents ??
    obj.jobs ??
    obj.items ??
    obj.plan ??
    obj.steps ??
    obj.list;

  let rawTasks = rawTasksCandidate;
  for (let i = 0; i < 3 && typeof rawTasks === "string"; i++) {
    const parsed = parseJsonIfString(rawTasks);
    if (parsed === rawTasks) break;
    rawTasks = parsed;
  }

  // If `rawTasks` is a single task object or string, wrap into an array.
  if (rawTasks && !Array.isArray(rawTasks)) {
    if (typeof rawTasks === "object" || typeof rawTasks === "string") {
      rawTasks = [rawTasks];
    }
  }

  // If no task array was found, but `obj` itself looks like a single task (has prompt/title/instruction/task),
  // treat the whole object as a single task.
  if (!Array.isArray(rawTasks)) {
    if (
      typeof obj.prompt === "string" ||
      typeof obj.instruction === "string" ||
      typeof obj.title === "string" ||
      typeof obj.task === "string"
    ) {
      rawTasks = [obj];
    } else {
      rawTasks = [];
    }
  }

  if (typeof obj.max_concurrency === "string") {
    const n = Number(obj.max_concurrency);
    if (Number.isFinite(n)) obj.max_concurrency = n;
  }

  const taskList = rawTasks as unknown[];

  // Build an ID/name/title -> index map for resolving named `depends_on` (e.g. depends_on: ["map"] or "map").
  const idToIndex = new Map<string, number>();
  taskList.forEach((t, idx) => {
    let item = t;
    if (typeof item === "string") {
      item = parseJsonIfString(item);
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.id === "string" || typeof rec.id === "number") {
        idToIndex.set(String(rec.id), idx);
      }
      if (typeof rec.name === "string" && rec.name.trim()) {
        idToIndex.set(rec.name.trim(), idx);
      }
      if (typeof rec.title === "string" && rec.title.trim()) {
        idToIndex.set(rec.title.trim(), idx);
      }
    }
  });

  obj.tasks = taskList.map((t, idx) => {
    let parsed = parseJsonIfString(t);
    if (typeof parsed === "string") {
      return {
        type: "general",
        prompt: parsed,
        description: parsed.slice(0, 60),
      };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const task = { ...(parsed as Record<string, unknown>) };

      // Resolve prompt from common synonyms if missing/empty
      const prompt =
        (typeof task.prompt === "string" && task.prompt.trim()
          ? task.prompt
          : typeof task.instruction === "string" && task.instruction.trim()
            ? task.instruction
            : typeof task.title === "string" && task.title.trim()
              ? task.title
              : typeof task.description === "string" && task.description.trim()
                ? task.description
                : typeof task.task === "string" && task.task.trim()
                  ? task.task
                  : typeof task.query === "string" && task.query.trim()
                    ? task.query
                    : typeof task.goal === "string" && task.goal.trim()
                      ? task.goal
                      : typeof task.content === "string" && task.content.trim()
                        ? task.content
                        : typeof task.name === "string" && task.name.trim()
                          ? task.name
                          : "") || `Task #${idx + 1}`;
      task.prompt = prompt;

      // Resolve description
      if (typeof task.description !== "string" || !task.description.trim()) {
        if (typeof task.title === "string" && task.title.trim()) {
          task.description = task.title.trim();
        } else if (typeof task.name === "string" && task.name.trim()) {
          task.description = task.name.trim();
        } else if (typeof task.prompt === "string" && task.prompt.trim()) {
          task.description = task.prompt.slice(0, 60).trim();
        }
      }

      // Resolve type
      if (typeof task.type !== "string" || !task.type.trim()) {
        const altType =
          typeof task.role === "string" && task.role.trim()
            ? task.role
            : typeof task.agent === "string" && task.agent.trim()
              ? task.agent
              : typeof task.worker === "string" && task.worker.trim()
                ? task.worker
                : undefined;
        if (altType) {
          task.type = altType;
        } else {
          task.type = "general";
        }
      }

      // Resolve depends_on
      let rawDeps = task.depends_on;
      if (typeof rawDeps === "string") {
        const parsedDeps = parseJsonIfString(rawDeps);
        rawDeps = parsedDeps;
      }
      if (typeof rawDeps === "number" || typeof rawDeps === "string") {
        rawDeps = [rawDeps];
      }
      if (Array.isArray(rawDeps)) {
        const resolvedDeps: number[] = [];
        for (const d of rawDeps) {
          if (typeof d === "number" && Number.isInteger(d)) {
            resolvedDeps.push(d);
          } else if (typeof d === "string") {
            const trimmed = d.trim();
            if (/^\d+$/.test(trimmed)) {
              resolvedDeps.push(parseInt(trimmed, 10));
            } else if (idToIndex.has(trimmed)) {
              resolvedDeps.push(idToIndex.get(trimmed)!);
            }
          }
        }
        task.depends_on = resolvedDeps;
      } else {
        delete task.depends_on;
      }

      return task;
    }
    return {
      type: "general",
      prompt: `Task #${idx + 1}`,
    };
  });

  return obj;
}

/** Normalise the single `run_subagent` call: accept a stringified input or synonym keys. */
export function normalizeSingleInput(input: unknown): unknown {
  let value = input;
  for (let i = 0; i < 3 && typeof value === "string"; i++) {
    const parsed = parseJsonIfString(value);
    if (parsed === value) break;
    value = parsed;
  }
  if (!value) return value;
  if (typeof value === "string") {
    return { prompt: value, type: "general" };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = { ...(value as Record<string, unknown>) };
    const prompt =
      (typeof obj.prompt === "string" && obj.prompt.trim()
        ? obj.prompt
        : typeof obj.instruction === "string" && obj.instruction.trim()
          ? obj.instruction
          : typeof obj.title === "string" && obj.title.trim()
            ? obj.title
            : typeof obj.task === "string" && obj.task.trim()
              ? obj.task
              : typeof obj.description === "string" && obj.description.trim()
                ? obj.description
                : typeof obj.query === "string" && obj.query.trim()
                  ? obj.query
                  : typeof obj.goal === "string" && obj.goal.trim()
                    ? obj.goal
                    : typeof obj.content === "string" && obj.content.trim()
                      ? obj.content
                      : typeof obj.name === "string" && obj.name.trim()
                        ? obj.name
                        : "") || "Carry out subagent task";
    obj.prompt = prompt;
    if (typeof obj.description !== "string" || !obj.description.trim()) {
      if (typeof obj.title === "string" && obj.title.trim()) {
        obj.description = obj.title.trim();
      } else if (typeof obj.name === "string" && obj.name.trim()) {
        obj.description = obj.name.trim();
      }
    }
    if (typeof obj.type !== "string" || !obj.type.trim()) {
      obj.type =
        typeof obj.role === "string" && obj.role.trim()
          ? obj.role
          : typeof obj.agent === "string" && obj.agent.trim()
            ? obj.agent
            : "general";
    }
    return obj;
  }
  return value;
}
