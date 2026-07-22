---
type: reference
title: "codeaudit-mcp — AI Coding Agent Guardrails (v1) design"
created: 2026-07-22
status: approved
related:
  - "[[roadmap]]"
  - "[[architecture]]"
---

# codeaudit-mcp — AI Coding Agent Guardrails (v1)

## Problem

AI coding assistants (Claude Code, Cursor, Copilot, Cline, Aider, OpenHands,
etc.) sometimes recommend or install packages that don't exist
(hallucinated/"phantom"), are typosquats, or are low-quality/abandoned. Today
CodeAudit only catches this *after the fact*, in a scan of committed code.
There's no way for an agent to check a package *before* running
`npm install`/`pip install`.

## Goal (v1 scope)

Give any MCP-capable coding agent a tool it can call, before installing a
package, to get an instant verdict: does this package exist, is it a likely
typo of something real, is it suspicious, does it have known CVEs. Reuse the
existing `@codeaudit/engine` checks — this is a protocol wrapper, not new
detection logic.

Out of scope for v1 (future work): hard/blocking enforcement (MCP tool
descriptions cannot force a call — see "Enforcement model" below), the AI
Package Advisor / intent-based recommendation (separate feature, item 3),
IDE-native extensions, org-wide policy.

## Architecture

New top-level workspace `mcp/`, published to npm as `codeaudit-mcp`,
alongside the existing `cli/`, `packages/engine/`, `server/`, `web/`
workspaces. It depends directly on `@codeaudit/engine` (same dependency the
CLI has) — no new detection logic needed for v1.

Distribution mirrors `codeaudit-scan`: published standalone so an agent's MCP
config can invoke it via `npx codeaudit-mcp` with zero separate install
step. Transport is stdio (the standard local-MCP-server transport used by
Claude Code, Cursor, Cline, and other MCP-native clients).

```
agent (Claude Code / Cursor / etc.)
  │  MCP stdio
  ▼
mcp/ (codeaudit-mcp)
  │  imports
  ▼
@codeaudit/engine  →  registry.ts / python/registry.ts / typosquat.ts / vulns.ts
  │  HTTP (offline path)              │  HTTP (hosted path, token only)
  ▼                                   ▼
registry.npmjs.org / pypi.org /   POST /api/mcp/alternatives (new, server/)
osv.dev                               │
                                       ▼
                              suggestAlternatives() (llm.ts, existing)
```

## Tools exposed

### `verify_package({ name, ecosystem?, version? })`

Runs the same per-package checks a scan does:
1. Does it exist on the registry (npm/PyPI)? `ecosystem` is optional —
   if omitted, try npm then PyPI (agents often only have a bare name).
2. If it doesn't exist (phantom): offline fuzzy "did you mean" match
   (`fuzzyAlternative`, always runs, no token needed); if that finds nothing
   AND a `CODEAUDIT_TOKEN` is configured, additionally ask the hosted
   LLM-alternative endpoint.
3. If it exists: typosquat check (near-neighbor of a popular package),
   weekly/monthly download count, package age, known CVEs via OSV (already
   free/offline, no token needed).

Returns a structured verdict: `{ exists, status, reason, alternatives?,
vulnerabilities?, weeklyDownloads?, ageDays? }`.

### `verify_packages({ packages: [{ name, ecosystem? }] })`

Same checks, batched with the engine's existing concurrency limiting — for
reviewing an entire new dependency list (a `package.json`/`requirements.txt`
diff) in one call instead of one round-trip per package.

### Tool description text (the v1 "enforcement" mechanism)

Both tool descriptions explicitly instruct the calling agent:

> "Call this before running an install command for any package the user did
> not explicitly name, and before adding a new entry to a manifest file.
> Returns whether the package is real, trustworthy, and whether a safer
> alternative exists."

This is advisory only — an MCP tool description cannot force invocation, the
calling agent decides based on its own instructions. Real-world uptake
depends on the user also adding a one-line rule to their agent's
instructions file (see Setup below). A CI backstop already exists
independent of this feature: the CLI already exits 1 on any phantom
dependency, so `codeaudit-scan` in CI catches anything an agent installed
without checking.

## Data flow: local-first, hosted-optional

1. On startup, read `CODEAUDIT_TOKEN` from env — the same per-repo token
   variable the CLI's `--upload` flag already uses (`ca_...`, issued via the
   existing `POST /repos/:repoId/cli-token` endpoint).
2. **No token:** every call runs fully offline against `@codeaudit/engine` —
   same registry/OSV/typosquat logic the CLI already runs, no account
   needed.
3. **Token present:** local checks still run first (fast, free). For any
   package that comes back phantom with no fuzzy match, additionally call a
   new endpoint, `POST /api/mcp/alternatives`, authenticated the same way
   `cliUploadRouter` authenticates today (the per-repo `ca_` token, not a
   user JWT — the MCP server runs locally with no browser session). That
   endpoint wraps the existing `suggestAlternatives()` (`llm.ts`) so the
   user's own LLM key never has to live on their machine.
4. If the hosted call fails or times out, return the local-only result —
   never block the tool response on the network call succeeding.

## Error handling

Registry/OSV lookups already tolerate failures in the engine (fall back to
"healthy-unknown" / no CVE data rather than throwing) — the MCP layer
inherits this for free. A failed hosted call degrades to local-only
silently, matching the CLI's existing `--upload` failure handling (reports
the error, never fails the underlying check).

## Setup & user guidance

- `mcp/README.md` ships copy-pasteable config snippets for the major
  clients: Claude Code (`.claude/mcp.json` / `claude mcp add`), Cursor
  (`.cursor/mcp.json`), and a generic `command`/`args` block for other
  MCP-compatible agents — all pointing at `npx codeaudit-mcp`, with
  `CODEAUDIT_TOKEN` documented as an optional env var.
- Recommended one-line addition to the user's agent-instructions file (e.g.
  `CLAUDE.md`): *"Before installing any new package, call the CodeAudit
  `verify_package` tool."* This is the piece that actually drives adoption,
  since v1 has no hard enforcement.
- Main repo `README.md` gets a short "Guardrails for AI coding agents"
  section, peer to the existing CLI section, linking to `mcp/README.md`.

## Testing

An MCP server communicates over stdio JSON-RPC — testable by spawning the
built server as a child process and sending raw tool-call requests,
asserting on the JSON response; no live agent required. Add
`mcp/test/ground-truth.ts` mirroring the existing
`server/test/ground-truth*.ts` style: known-phantom, known-typo, and
known-healthy packages for the offline path; a separate (skipped without
`CODEAUDIT_TOKEN`) check for the hosted-alternative path.

## Business framing

- **Tier:** Free — this is the guardrail that gets a developer to *notice*
  CodeAudit exists, the same role the CLI plays today. No paywall on
  `verify_package`/`verify_packages` themselves.
- **Upsell surface:** the hosted-alternative enrichment (requires a
  CodeAudit account + token) and, later, org-wide policy ("block installs
  below trust score N across the team") are natural Pro/Enterprise
  attachments once this ships and gets used.
- **Differentiation:** none of the listed competitor tools (Socket.dev,
  Snyk, CodeScene, SonarQube) expose an MCP-native pre-install check today —
  this is the guardrail positioning from the master prompt (item 9), and the
  most agent-native surface CodeAudit has shipped so far.

## MVP checklist

- [ ] `mcp/` workspace scaffold (package.json, tsconfig, build script mirroring `cli/`)
- [ ] stdio MCP server wiring `verify_package` + `verify_packages`
- [ ] Hybrid local/hosted logic in the tool handlers
- [ ] New `POST /api/mcp/alternatives` endpoint (server/), reusing `suggestAlternatives()`
- [ ] `mcp/test/ground-truth.ts`
- [ ] `mcp/README.md` + main README section
