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

Add to your agent's MCP config, pointing at `npx codeaudit-mcp`:

**Claude Code** (`.claude/mcp.json` or via `claude mcp add`):

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

**Cursor** (`.cursor/mcp.json`): identical shape to the above.

**Any other MCP-compatible client**: use the same `command`/`args` —
`npx -y codeaudit-mcp` — with `CODEAUDIT_TOKEN` as an optional env var.

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
