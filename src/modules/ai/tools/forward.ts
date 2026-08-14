import { tool } from "ai";
import { z } from "zod";
import { openSshForward } from "@/modules/ssh/bridge";
import { remoteUnsupported } from "../lib/remoteFs";
import type { ToolContext } from "./context";

export function buildForwardTools(ctx: ToolContext) {
  return {
    forward_remote_port: tool({
      description:
        "Tunnel a port on the connected SSH host to this machine, so a service running on the server becomes reachable at 127.0.0.1 locally. Use it after starting something on the server that you or the user needs to open — a dev server, an admin UI, a database. Returns the local port, which is then a localhost URL `open_preview` will accept. The tunnel closes with the SSH session. Asks for approval.",
      inputSchema: z.object({
        remote_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .describe("Port the service listens on, as seen from the server."),
        remote_host: z
          .string()
          .optional()
          .describe(
            "Host to reach from the server. Defaults to 127.0.0.1, which is the service running on the server itself.",
          ),
        local_port: z
          .number()
          .int()
          .min(0)
          .max(65535)
          .optional()
          .describe("Local port to bind. Omit or pass 0 to let the OS pick a free one."),
      }),
      needsApproval: true,
      execute: async ({ remote_port, remote_host, local_port }) => {
        const remote = ctx.getRemoteSession();
        if (!remote) {
          // Not a remote-only tool that fell back to local: there is simply
          // nothing to tunnel from without a session.
          return remoteUnsupported(
            "Port forwarding",
            "Open an SSH connection first; there is no remote host to tunnel from.",
          );
        }
        try {
          const bound = await openSshForward(
            remote.sessionId,
            local_port ?? 0,
            remote_host ?? "127.0.0.1",
            remote_port,
          );
          return {
            forwarded: true,
            local_port: bound,
            // The whole point of the tool: this is a localhost URL, which is
            // what open_preview accepts and what a browser can reach.
            local_url: `http://127.0.0.1:${bound}`,
            remote: `${remote_host ?? "127.0.0.1"}:${remote_port}`,
            note: "The tunnel lasts as long as the SSH session.",
          };
        } catch (e) {
          return { error: String(e), remote_port };
        }
      },
    }),
  };
}
