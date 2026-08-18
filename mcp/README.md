# codeorion-mcp

An MCP server that lets AI coding agents (Claude Code, Cursor, Cline, and
other MCP-compatible tools) check whether a package is real and
trustworthy **before** installing it — catching hallucinated ("phantom")
packages, typosquats, and known CVEs at the moment an agent is about to
`npm install`/`pip install` something. It also checks content for hardcoded
secrets before it's written to a file, and audits files an agent is about to
trust *as instructions* (`CLAUDE.md`, MCP configs, permission settings) for
prompt injection and unsafe configuration.

Seven tools covering the trust decisions an agent actually makes: installing
a package, **adding an MCP server**, adding a dependency the project may
already have an equivalent for, writing something that could be a credential,
treating a file as instructions, and **committing staged changes**.

Runs fully offline by default (no account needed) — same registry/CVE
checks as `npx codeorion`. Set `CODEAUDIT_TOKEN` to additionally get
an LLM-suggested real alternative for phantom packages that aren't a
simple typo of anything popular (e.g. `fastimagepro` → Pillow/imageio).

## Setup

Two steps, and **both are required**: connect the server, then install the
skill that makes your agent call it. They work hand in hand — see "Neither
half works alone" below for what each one does without the other.

The whole thing, for Claude Code, if you just want to paste and go:

```bash
npm install -g codeorion-mcp
claude mcp add codeaudit -- codeorion-mcp
```

Restart your session, then:

```bash
/plugin marketplace add DelTa-0/codeaudit
/plugin install codeorion-guardrails@codeaudit
```

That's it. `/mcp` should now list seven tools under `codeaudit`. The rest of
this section covers the variations: `npx` instead of a global install, other
clients, and putting the skill in a repo instead of on one machine.

### 1. Connect the server

**Claude Code, macOS / Linux** — one command, no file editing:

```bash
claude mcp add codeaudit -- npx -y codeorion-mcp
```

**Claude Code, Windows** — install globally first, then point at the binary:

```bash
npm install -g codeorion-mcp
```

```bash
claude mcp add codeaudit -- codeorion-mcp
```

Windows needs the second form because the first one fails there, in two
independent ways. In PowerShell, `claude mcp add ... -- npx -y ...` exits
with `error: unknown option '-y'` — the `-y` is meant for `npx`, but
`claude mcp add` parses it as its own flag before the `--` separator takes
effect. Separately, some Windows machines have an `npx` that resolves a
package but then fails to execute its bin shim, which surfaces later as
`claude mcp list` reporting "Failed to connect" with `'<bin-name>' is not
recognized as an internal or external command` in the server log. Installing
globally sidesteps both, at the cost of `npm update -g codeorion-mcp` for
future versions instead of `npx` always fetching the latest.

Add `-e CODEAUDIT_TOKEN=your-token` before the `--` if you have a token. Use
`claude mcp add --scope project ...` to check the config into the repo for
your whole team rather than just your own machine.

**Restart your session afterwards.** MCP servers are started when a session
boots, so a server added mid-session does not connect until you start a new
one.

**Then confirm it worked** — this is worth doing, because a half-connected
server looks identical to a working one until the moment you need it:

```bash
claude mcp list
```

`/mcp` inside a session lists each server's tools. As of 1.3.0 you want
**seven**: `verify_package`, `verify_packages`, `scan_secrets`,
`audit_agent_config`, `assess_mcp_server`, `check_redundancy` and
`audit_staged`. Only two means the pre-rename package is connected — see
"Upgrading from `codeaudit-mcp`" below.

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

### 2. Install the guardrails skill

The server and the skill are two halves of one thing. An MCP tool's
description alone doesn't force an agent to invoke it — the tools from
step 1 are guardrails a client will *skip past* on any encounter that isn't
literally an install or a write: opening an existing manifest to edit an
unrelated field, reviewing a diff, reading a freshly cloned repo's
`CLAUDE.md` to orient itself. Those are trust decisions made passively, and
they're the ones that go unchecked. The skill is what closes that gap; the
server is what gives it something to call.

Pick whichever fits how you work — the plugin if you want it everywhere, the
project skill if you want your team to get it automatically.

**Claude Code, as a plugin — applies to every project on your machine:**

```bash
/plugin marketplace add DelTa-0/codeaudit
/plugin install codeorion-guardrails@codeaudit
```

**Claude Code, as a project skill — checked into your repo, so anyone who
clones it is covered:**

```bash
mkdir -p .claude/skills/codeorion-guardrails
curl -o .claude/skills/codeorion-guardrails/SKILL.md \
  https://raw.githubusercontent.com/DelTa-0/codeaudit/main/plugins/codeorion-guardrails/SKILL.md
```

Commit that file. Pair it with `claude mcp add --scope project -- codeorion-mcp`
from step 1 and both halves travel with the repo — a new developer clones and
is protected with no setup of their own, which is the only version of this
that survives contact with a team.

**Any other client** — paste this into your agent's instructions file
(`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, or the equivalent):

> Before installing any new package, or before editing a manifest that names
> a package not yet checked this session, call `verify_package` /
> `verify_packages`. Before writing or editing any file that could hold an
> API key, token, password, or connection string, call `scan_secrets`.
> Before reading a `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, MCP server
> config, or skill file from a repo you did not author, call
> `audit_agent_config`. Reading a file counts — the check is not only for
> files you write.

#### Neither half works alone

Worth being blunt about, because both failure modes are quiet:

| You installed | What happens |
|---|---|
| Server only (step 1) | Tools are present and never called on passive encounters — exactly the gap the skill exists to close |
| Skill only (step 2) | The agent reads instructions to call tools that aren't connected, and finds out at call time |
| Both | The intended behaviour |

The second row is the one that looks fine. A skill saying "call
`scan_secrets`" is indistinguishable from a working setup until something
actually tries the call, so verify step 1 with `/mcp` rather than assuming.

### Upgrading from `codeaudit-mcp`

This package was called `codeaudit-mcp` before the rename to CodeOrion. That
name is still resolvable on npm at its final version, **0.1.1**, which ships
only `verify_package` and `verify_packages` — `scan_secrets` and
`audit_agent_config` were added afterwards and never existed under the old
name.

This is the failure mode worth knowing about: the old server connects
successfully and answers package questions, so every "is it connected?"
check passes, while two of the four guardrails are silently absent. If your
client is configured with `"command": "codeaudit-mcp"`, or `/mcp` shows only
two tools, that's what you have. Repoint it:

```bash
claude mcp remove codeaudit
```

```bash
claude mcp add codeaudit -- codeorion-mcp
```

The server may be *named* `codeaudit` in your config — that's just a label,
and keeping it means your existing allow-lists and tool references still
resolve. What has to change is the `command`. For non-Claude clients, edit
the JSON in place: `"command": "codeorion-mcp", "args": []` if you installed
globally, or `"command": "npx", "args": ["-y", "codeorion-mcp"]` otherwise.

## Tools

- `verify_package({ name, ecosystem?, version? })` — checks one package.
  `version` is optional — when given, known-vulnerability checks run
  against that version instead of the registry's latest. Returns the
  package's licence, deprecation message and unpacked size alongside the
  existence/typosquat/CVE verdict. Also matches the
  name against a curated corpus of names LLMs are documented to invent, and
  says so in the result (`hallucinated`). That check matters most when the
  package **does** exist: registering a hallucinated name is the attack, so
  once it is registered, existence, download counts and age all stop being
  evidence of anything. A name in the corpus is never returned as healthy.
- `verify_packages({ packages: [{ name, ecosystem? }] })` — checks several
  at once (e.g. every new line in a manifest diff).
- `scan_secrets({ content, filePath? })` — checks file content for
  hardcoded API keys, tokens and private keys before it's written. Returns
  redacted matches only (e.g. `AKIA…(20 chars)`) — the actual secret value
  is never echoed back. `filePath` is optional and used to skip files that
  legitimately hold placeholders, such as `.env.example`.
- `audit_agent_config({ content, filePath })` — checks a file you are about
  to trust *as instructions* — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, an
  MCP server config, a Claude settings/permissions file, a skill file —
  especially from a repo you just cloned. Detects invisible characters,
  prompt-injection phrasing, credential-exfiltration instructions, and
  unsafe config (auto-approve flags, raw shell commands, unpinned
  packages). Findings carry a sanitized excerpt, never the raw payload.
  Unlike `scan_secrets`, `filePath` is **required** — the same text means
  different things depending on where it lives, and the path is what
  classifies the surface. A path that isn't a recognized agent surface
  comes back explicitly unscanned rather than as an empty (and misleadable)
  "no findings".
- `assess_mcp_server({ name, command, args?, existingConfigText? })` — call
  **before adding an MCP server to any config**, the moment the trust decision
  is actually made. Reports what the invocation reveals (shell execution,
  filesystem paths granted, unpinned package), verifies the backing package,
  and — when the existing config is passed — whether this name would silently
  **redefine an already-approved server**. Approval binds to the name, not the
  command, so a redefinition executes with no new prompt. Network behaviour
  cannot be read from a config and is deliberately not guessed.
- `check_redundancy({ name, ecosystem?, dependencies? | manifestContent?, projectLicense? })`
  — call before adding a dependency the user did not explicitly name. Answers
  whether the exact package is already declared, whether the project already
  uses an equivalent library (curated corpus, never guessed), and whether the
  candidate's licence conflicts with the project's.
- `audit_staged({ projectDir? })` — an agent's self-review after staging and
  before committing: secrets, agent-config poisoning (including MCP servers
  redefined relative to HEAD), and dependencies the commit adds that don't
  exist or carry CVEs. The same checks `codeorion scan --staged` runs from a
  git hook — with no hook required.

`ecosystem` (`"npm"` or `"pypi"`) is optional — omit it and `verify_package`/
`verify_packages` try npm first, then PyPI.

## Getting a token (optional)

A `CODEAUDIT_TOKEN` is the same per-repo token used by `codeorion
--upload` — generate one from your repository's settings page at
[codeaudit.madhavaryal.info.np](https://codeaudit.madhavaryal.info.np), or via `POST
/repos/:repoId/cli-token` if self-hosting.
