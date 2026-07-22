# codeaudit-mcp

An MCP server that lets AI coding agents (Claude Code, Cursor, Cline, and
other MCP-compatible tools) check whether a package is real and
trustworthy **before** installing it — catching hallucinated ("phantom")
packages, typosquats, and known CVEs at the moment an agent is about to
`npm install`/`pip install` something.

Runs fully offline by default (no account needed) — same registry/CVE
checks as `npx codeaudit-scan`. Set `CODEAUDIT_TOKEN` to additionally get
an LLM-suggested real alternative for phantom packages that aren't a
simple typo of anything popular (e.g. `fastimagepro` → Pillow/imageio).

## Setup

**Claude Code** — one command, no file editing:

```bash
claude mcp add codeaudit -- npx -y codeaudit-mcp
```

(Add `-e CODEAUDIT_TOKEN=your-token` before `--` if you have one. Use
`claude mcp add --scope project ...` instead to check the config into the
repo for your whole team rather than just your own machine.)

**Cursor** — click to install:

[![Add codeaudit-mcp to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=codeaudit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvZGVhdWRpdC1tY3AiXX0=)

Or manually via **Settings → MCP → Add new MCP server**, pointing the
command at `npx -y codeaudit-mcp`.

**Any other MCP-compatible client** (Cline, Windsurf, etc.) — add this to
whatever JSON config the client reads (e.g. Cline's `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "codeaudit": {
      "command": "npx",
      "args": ["-y", "codeaudit-mcp"],
      "env": { "CODEAUDIT_TOKEN": "" }
    }
  }
}
```

Then add one line to your agent's instructions file (e.g. `CLAUDE.md`) so
the agent actually calls it — an MCP tool's description alone doesn't force
an agent to invoke it:

> Before installing any new package, call the CodeAudit `verify_package`
> tool.

## Tools

- `verify_package({ name, ecosystem? })` — checks one package.
- `verify_packages({ packages: [{ name, ecosystem? }] })` — checks several
  at once (e.g. every new line in a manifest diff).

`ecosystem` (`"npm"` or `"pypi"`) is optional — omit it and the tool tries
npm first, then PyPI.

## Getting a token (optional)

A `CODEAUDIT_TOKEN` is the same per-repo token used by `codeaudit-scan
--upload` — generate one from your repository's settings page at
[codeaudit.dev](https://codeaudit.dev), or via `POST
/repos/:repoId/cli-token` if self-hosting.
