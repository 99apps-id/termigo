// Detecting a project's dev-server command and its port, for the `dev_server`
// tool. Pure and unit-testable: the tool combines these helpers with the
// background shell + `findLocalUrl` + the loopback `http_probe`.

export type DevManifests = {
  pkgJson: string | null;
};

/** Framework → default dev port, used when the command does not pin one. */
const DEFAULT_PORTS: ReadonlyArray<[RegExp, number]> = [
  [/vite|astro|svelte|solid|qwik/i, 5173],
  [/next|nuxt|remix/i, 3000],
  [/webpack|vue-cli|@vue\/cli|craco|react-scripts/i, 8080],
  [/cargo|trunk|warp|axum|actix|rocket/i, 8000],
  [/go run|gin|echo|fiber|air\b/i, 8080],
  [/flask|uvicorn|fastapi|django|gunicorn/i, 8000],
  [/jekyll|hugo/i, 4000],
  [/parcel/i, 1234],
  [/preview/i, 4173],
];

/** Pick the scripts entry the model/user means by "dev". */
export function devScriptCommand(pkgJson: string | null): {
  command: string;
  name: string;
} | null {
  if (!pkgJson) return null;
  try {
    const pkg = JSON.parse(pkgJson) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const name of ["dev", "start", "serve", "develop", "dev:web"]) {
      const raw = scripts[name];
      if (typeof raw === "string" && raw.trim()) {
        return { command: raw.trim(), name };
      }
    }
  } catch {
    // Not JSON — nothing to detect.
  }
  return null;
}

/** Extract an explicit port from a dev command: `--port 5173`, `-p 5173`,
 *  `PORT=5173` env, or a `:5173` in a printed host. Returns null when the
 *  command does not name a port. */
export function portFromCommand(command: string): number | null {
  // --port 5173 / -p 5173 (flag followed by value)
  const flag = /(?:^|\s)(?:--port|-p)\s+(\d{1,5})/.exec(command);
  if (flag) return clampPort(Number(flag[1]));
  // --port=5173
  const eq = /(?:^|\s)--port=(\d{1,5})/.exec(command);
  if (eq) return clampPort(Number(eq[1]));
  // PORT=5173 prefix
  const env = /(?:^|\s)PORT=(\d{1,5})(?:\s|$)/.exec(command);
  if (env) return clampPort(Number(env[1]));
  // :5173 inside a host/url the command carries
  const host = /(?:https?:\/\/[^:/\s]+|localhost|127\.0\.0\.1):(\d{1,5})/.exec(
    command,
  );
  if (host) return clampPort(Number(host[1]));
  return null;
}

function clampPort(n: number): number | null {
  return n >= 1 && n <= 65535 ? n : null;
}

/** A sensible default port for a dev command, by framework heuristic. */
export function defaultDevPort(command: string): number {
  for (const [re, port] of DEFAULT_PORTS) {
    if (re.test(command)) return port;
  }
  return 3000;
}

/** The port to probe first: explicit > framework default. */
export function devPort(command: string): number {
  return portFromCommand(command) ?? defaultDevPort(command);
}

/** Loopback URLs to probe for a port, in order. `localhost` may resolve to
 *  IPv6 (`::1`) where the server bound only IPv4, so 127.0.0.1 is probed too. */
export function candidateUrls(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/** Resolve a project's dev-server command from its manifests.
 *  Returns null when nothing declares a dev script. The port is a hint only —
 *  the tool learns the real URL from the server's own log via `findLocalUrl`. */
export function detectDevCommand(
  manifests: DevManifests,
): { command: string; script: string; portHint: number } | null {
  const found = devScriptCommand(manifests.pkgJson);
  if (!found) return null;
  return {
    command: found.command,
    script: found.name,
    portHint: devPort(found.command),
  };
}

/** Whether two background processes run the same dev command (for dedupe). */
export function sameDevCommand(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  const na = norm(a).toLowerCase();
  const nb = norm(b).toLowerCase();
  return na === nb || na.includes(nb) || nb.includes(na);
}
