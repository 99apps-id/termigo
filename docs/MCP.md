# MCP integration

Termigo speaks the [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) to local servers over stdio. An MCP server exposes tools (filesystem,
search, git, databases, browser automation, ...) that agents can call.

## Configuration

Servers use the standard MCP shape in a JSON registry:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {}
    }
  }
}
```

Registries are read from two places and merged:

| Scope    | File                        |
| ---      | ---                         |
| Project  | `<workspace>/.termigo/mcp.json` |
| User     | `~/.termigo/mcp.json` (or `$TERMIGO_HOME/mcp.json`) |

Project-scoped servers are shared through the repository; user-scoped servers
stay on your machine.

## CLI usage

```powershell
termigo init <project-dir>                 # scaffolds .termigo/mcp.json
termigo mcp list                           # show the merged registry
termigo mcp add fs npx -y @modelcontextprotocol/server-filesystem .
termigo mcp remove fs
termigo mcp tools                          # connect to every server, list tools
termigo mcp tools fs                       # list tools of one server
termigo mcp call fs read_file path=README.md
termigo mcp ping fs                        # handshake + ping
```

## Protocol notes

- Messages are JSON-RPC 2.0, one object per line, over the server's stdio.
- The client performs `initialize`, sends `notifications/initialized`, then
  uses `tools/list`, `tools/call`, and `ping`.
- The protocol version is `2024-11-05`.
- npx-based servers cold-start slowly on first use; the client waits up to
  60 seconds for the handshake. If the server process exits during startup,
  its stderr tail is included in the error.
- The registry is intentionally *explicit*: nothing runs until you connect.
- Credentials for a server come from its own environment; Termigo stores no
  keys in the registry file.

## Example servers

| Server | Command |
| --- | --- |
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem <absolute-path>` |
| Everything (demo) | `npx -y @modelcontextprotocol/server-everything` |
| Git | `uvx mcp-server-git --repository <path>` |
| GitHub | `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server` |

## Safety

- Only servers you explicitly configure are started.
- Agent execution stays sandboxed by the access mode (`read-only` vs
  `workspace-write`); MCP tools are a separate permission surface.
- Review `mcp list` before running `mcp tools` or `mcp call`.
