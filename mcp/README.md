# codeorion-mcp

An MCP server that lets AI coding agents (Claude Code, Cursor, Cline, and
other MCP-compatible tools) check whether a package is real and
trustworthy **before** installing it — catching hallucinated ("phantom")
packages, typosquats, and known CVEs at the moment an agent is about to
`npm install`/`pip install` something — and check content for hardcoded
secrets before it's written to a file.

Runs fully offline by default (no account needed) — same registry/CVE
checks as `npx codeorion`. Set `CODEAUDIT_TOKEN` to additionally get
an LLM-suggested real alternative for phantom packages that aren't a
simple typo of anything popular (e.g. `fastimagepro` → Pillow/imageio).

## Setup

**Claude Code** — one command, no file editing:

```bash
claude mcp add codeaudit -- npx -y codeorion-mcp
```

(Add `-e CODEAUDIT_TOKEN=your-token` before `--` if you have one. Use
`claude mcp add --scope project ...` instead to check the config into the
repo for your whole team rather than just your own machine.)

**Cursor** — click to install:

[![Add codeorion-mcp to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=codeaudit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImNvZGVvcmlvbi1tY3AiXX0=)

Or manually via **Settings → MCP → Add new MCP server**, pointing the
command at `npx -y codeorion-mcp`.

**Any other MCP-compatible client** (Cline, Windsurf, etc.) — add this to
whatever JSON config the client reads (e.g. Cline's `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "codeaudit": {
      "command": "npx",
      "args": ["-y", "codeorion-mcp"],
      "env": { "CODEAUDIT_TOKEN": "" }
    }
  }
}
```

Then add a line to your agent's instructions file (e.g. `CLAUDE.md`) so
the agent actually calls these tools — an MCP tool's description alone
doesn't force an agent to invoke it:

> Before installing any new package, call the CodeAudit `verify_package`
> tool. Before writing or editing a file that could contain configuration
> or credentials, call `scan_secrets`.

### Windows: if `npx` fails to connect

Some Windows machines have an `npx` that fails to execute a resolved
package's bin shim even though the shim itself is correct (`claude mcp
list` reports "Failed to connect", and the server's log shows `'<bin-name>'
is not recognized as an internal or external command`). If you hit this,
skip `npx` entirely — install globally once and point the command straight
at the installed binary:

```bash
npm install -g codeorion-mcp
claude mcp add codeaudit -- codeorion-mcp
```

(For other clients, set `"command": "codeorion-mcp", "args": []` instead of
`npx`/`-y`/`codeorion-mcp`.) This bypasses the broken `npx` resolution step
entirely, at the cost of needing `npm update -g codeorion-mcp` manually for
future versions instead of `npx` always fetching latest.

## Tools

- `verify_package({ name, ecosystem?, version? })` — checks one package.
  `version` is optional — when given, known-vulnerability checks run
  against that version instead of the registry's latest.
- `verify_packages({ packages: [{ name, ecosystem? }] })` — checks several
  at once (e.g. every new line in a manifest diff).
- `scan_secrets({ content, filePath? })` — checks file content for
  hardcoded API keys, tokens and private keys before it's written. Returns
  redacted matches only (e.g. `AKIA…(20 chars)`) — the actual secret value
  is never echoed back. `filePath` is optional and used to skip files that
  legitimately hold placeholders, such as `.env.example`.

`ecosystem` (`"npm"` or `"pypi"`) is optional — omit it and `verify_package`/
`verify_packages` try npm first, then PyPI.

## Getting a token (optional)

A `CODEAUDIT_TOKEN` is the same per-repo token used by `codeorion
--upload` — generate one from your repository's settings page at
[codeaudit.dev](https://codeaudit.dev), or via `POST
/repos/:repoId/cli-token` if self-hosting.
