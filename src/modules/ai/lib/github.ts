import { native } from "./native";
import { checkShellCommand } from "./security";
import { quoteShellArg } from "@/lib/shellQuote";

export type GhPr = {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  baseRef: string;
  headRef: string;
};

export type GhComment = {
  id: number;
  body: string;
  author: string;
  createdAt: string;
};

export type GhReview = {
  id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  author: string;
  createdAt: string;
};

async function runGh(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exit_code: number | null }> {
  const command = `gh ${args.join(" ")}`;
  const safety = checkShellCommand(command);
  if (!safety.ok) {
    return { stdout: "", stderr: safety.reason, exit_code: 1 };
  }
  let shellId: number | null = null;
  try {
    shellId = await native.shellSessionOpen(cwd);
    const r = await native.shellSessionRun(shellId, command, cwd, 60);
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exit_code: r.exit_code,
    };
  } catch (e) {
    return { stdout: "", stderr: String(e), exit_code: 1 };
  } finally {
    if (shellId !== null) {
      void native.shellSessionClose(shellId).catch(() => {});
    }
  }
}

export async function createPr(
  title: string,
  body: string,
  base: string,
  head: string,
  cwd: string,
): Promise<{ ok: boolean; pr?: GhPr; error?: string }> {
  const args = [
    "pr",
    "create",
    `--title ${quoteShellArg(title)}`,
    `--body ${quoteShellArg(body)}`,
    `--base ${quoteShellArg(base)}`,
    `--head ${quoteShellArg(head)}`,
    "--json",
    "number,title,body,state,author,createdAt,updatedAt,url,baseRefName,headRefName",
  ];
  const r = await runGh(args, cwd);
  if (r.exit_code !== 0) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  try {
    const data = JSON.parse(r.stdout);
    const pr: GhPr = {
      number: data.number,
      title: data.title,
      body: data.body,
      state: data.state,
      author: data.author?.login ?? "unknown",
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      url: data.url,
      baseRef: data.baseRefName,
      headRef: data.headRefName,
    };
    return { ok: true, pr };
  } catch (e) {
    return { ok: false, error: `Failed to parse PR data: ${e}` };
  }
}

export async function getPr(
  number: number,
  cwd: string,
): Promise<{ ok: boolean; pr?: GhPr; error?: string }> {
  const args = [
    "pr",
    "view",
    String(number),
    "--json",
    "number,title,body,state,author,createdAt,updatedAt,url,baseRefName,headRefName",
  ];
  const r = await runGh(args, cwd);
  if (r.exit_code !== 0) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  try {
    const data = JSON.parse(r.stdout);
    const pr: GhPr = {
      number: data.number,
      title: data.title,
      body: data.body,
      state: data.state,
      author: data.author?.login ?? "unknown",
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      url: data.url,
      baseRef: data.baseRefName,
      headRef: data.headRefName,
    };
    return { ok: true, pr };
  } catch (e) {
    return { ok: false, error: `Failed to parse PR data: ${e}` };
  }
}

export async function listPrs(
  cwd: string,
  state: "open" | "closed" | "merged" | "all" = "open",
): Promise<{ ok: boolean; prs?: GhPr[]; error?: string }> {
  const args = [
    "pr",
    "list",
    `--state`,
    state,
    "--json",
    "number,title,body,state,author,createdAt,updatedAt,url,baseRefName,headRefName",
  ];
  const r = await runGh(args, cwd);
  if (r.exit_code !== 0) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  try {
    const data = JSON.parse(r.stdout);
    const prs: GhPr[] = data.map((item: Record<string, unknown>) => ({
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state,
      author: (item.author as Record<string, unknown> | undefined)?.login ? String((item.author as Record<string, unknown>).login) : "unknown",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      url: item.url,
      baseRef: item.baseRefName,
      headRef: item.headRefName,
    }));
    return { ok: true, prs };
  } catch (e) {
    return { ok: false, error: `Failed to parse PR list: ${e}` };
  }
}

export async function reviewPr(
  number: number,
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED",
  body: string,
  cwd: string,
): Promise<{ ok: boolean; review?: GhReview; error?: string }> {
  const args = [
    "pr",
    "review",
    String(number),
    `--${state.toLowerCase()}`,
    `--body ${quoteShellArg(body)}`,
    "--json",
    "id,state,body,author,createdAt",
  ];
  const r = await runGh(args, cwd);
  if (r.exit_code !== 0) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  try {
    const data = JSON.parse(r.stdout);
    const review: GhReview = {
      id: data.id,
      state: data.state,
      body: data.body,
      author: data.author?.login ?? "unknown",
      createdAt: data.createdAt,
    };
    return { ok: true, review };
  } catch (e) {
    return { ok: false, error: `Failed to parse review data: ${e}` };
  }
}

export async function commentPr(
  number: number,
  body: string,
  cwd: string,
): Promise<{ ok: boolean; comment?: GhComment; error?: string }> {
  const args = [
    "pr",
    "comment",
    String(number),
    `--body ${quoteShellArg(body)}`,
    "--json",
    "id,body,author,createdAt",
  ];
  const r = await runGh(args, cwd);
  if (r.exit_code !== 0) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  try {
    const data = JSON.parse(r.stdout);
    const comment: GhComment = {
      id: data.id,
      body: data.body,
      author: data.author?.login ?? "unknown",
      createdAt: data.createdAt,
    };
    return { ok: true, comment };
  } catch (e) {
    return { ok: false, error: `Failed to parse comment data: ${e}` };
  }
}

export async function mergePr(
  number: number,
  cwd: string,
  method: "merge" | "squash" | "rebase" = "merge",
): Promise<{ ok: boolean; error?: string }> {
  const args = ["pr", "merge", String(number), `--${method}`, "--yes"];
  const r = await runGh(args, cwd);
  if (r.exit_code !== 0) {
    return { ok: false, error: r.stderr || r.stdout };
  }
  return { ok: true };
}
