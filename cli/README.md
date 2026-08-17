# codeorion

A local, static scanner for AI-generated technical debt in JS/TS and Python
repos — phantom (hallucinated) dependencies, suspicious/typosquat packages,
unused dependencies, and dead-code _candidates_. No account, no signup,
nothing leaves your machine unless you opt in with `--upload`.

This is the CLI half of [CodeAudit](https://github.com/DelTa-0/codeaudit).
It does static analysis by default — no scan history, no PR integration.
Those stay platform-only at
[codeaudit.madhavaryal.info.np](https://codeaudit.madhavaryal.info.np); the CLI
is the free, offline way to try the core checks first. LLM-backed dead-code
review is also available, bring-your-own-key — see
[LLM review](#llm-review-optional-bring-your-own-key) below.

## Quick start

No install needed — run it straight from your repo root with `npx`:

```bash
npx codeorion scan .
```

That's it. It detects whether the repo is npm, PyPI, or both (polyglot
repos get scanned on both ecosystems in one pass), checks every declared
dependency against the live npm/PyPI registries, and flags exported
symbols with zero call-sites as dead-code candidates.

Prefer a permanent install? `npm install -g codeorion` then run
`codeorion scan .` directly — same behavior, just skips npx's
resolve-on-every-run step.

> **Every command below uses flags, not environment variables**, so the same
> line works unchanged in bash, zsh, PowerShell and cmd. The `VAR=value command`
> prefix common in CLI docs is bash/zsh syntax — on PowerShell it fails with
> `The term 'VAR=value' is not recognized`. If you prefer env vars, set them on
> their own line first: `$env:GROQ_API_KEY="gsk_…"` in PowerShell,
> `export GROQ_API_KEY=gsk_…` in bash.

## Usage

```
codeorion scan [dir] [options]
```

`dir` defaults to `.` (the current directory).

| Option          | Description                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--staged`      | Pre-commit mode — scan only what is staged for commit (see [Pre-commit hook](#pre-commit-hook))                               |
| `--json`        | Machine-readable output — one JSON object on stdout, for CI parsing                                                           |
| `--min-score N` | Exit `1` if the health score is below `N`                                                                                     |
| `--upload`      | Send results to your CodeAudit dashboard (requires a token; see [Uploading results](#uploading-results))                      |
| `--token T`     | Per-repo CLI token for `--upload` (or set `CODEAUDIT_TOKEN`)                                                                  |
| `--api URL`     | API base URL for `--upload` (or set `CODEAUDIT_API_URL`). Defaults to `https://codeaudit.madhavaryal.info.np` — only set it if you self-host |
| `--key K`       | Your own LLM API key for real dead-code review (or set `GROQ_API_KEY` / `OPENAI_API_KEY` / `CODEAUDIT_LLM_KEY`; see [LLM review](#llm-review-optional-bring-your-own-key)) |
| `--url URL`     | OpenAI-compatible base URL (or set `CODEAUDIT_LLM_URL`). Only needed for providers other than Groq and OpenAI                 |
| `--model M`     | Model name (or set `CODEAUDIT_LLM_MODEL`). Required with a custom `--url`; otherwise optional                                 |
| `-h`, `--help`  | Show usage                                                                                                                    |

### Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Clean — no phantom dependencies, score at/above `--min-score` if set |
| `1`  | Phantom dependencies found, or score below `--min-score`             |
| `2`  | Usage error or scan failure                                          |

Use the exit code directly as a CI gate:

```bash
npx codeorion scan . --min-score 80
```

## Pre-commit hook

```bash
npx codeorion install-hook
```

That writes `.git/hooks/pre-commit`, which runs `codeorion scan --staged` and
blocks the commit on anything it finds. Bypass a single commit the usual way,
with `git commit --no-verify`.

`--staged` is not a full scan, by design. A hook that runs on every commit has
a budget of a couple of seconds; a whole-repo scan resolves lock trees, queries
OSV for every dependency and may call an LLM. So it checks only what is both
fast and irreversible once committed:

| Checked at commit time | Why |
| --- | --- |
| Secrets in staged content | A committed credential is compromised even if the next commit removes it |
| Agent-config poisoning (`CLAUDE.md`, `.mcp.json`, skills, permissions) | No network needed, and these are read as instructions by your own tooling |
| Dependencies **this commit adds** | Bounded network cost — only the additions are checked, not the whole tree |

Dead code, license conflicts and duplicate libraries are deliberately left to
the full scan: they need whole-repo context, none of them are urgent at the
commit boundary, and blocking a commit on a dead-code *candidate* is how a
hook earns a permanent `--no-verify`.

It reads **the staged content**, not the working tree. Staging a file and then
editing it — or the reverse — is routine, and a hook that read the working tree
would be judging content that isn't being committed.

```bash
npx codeorion scan --staged           # run it directly
npx codeorion scan --staged --json    # machine-readable
```

`install-hook` will not overwrite a `pre-commit` hook it didn't write; it
prints the single line to add to yours instead. If you use the
[pre-commit framework](https://pre-commit.com), reference the repository
directly rather than using `install-hook`:

```yaml
repos:
  - repo: https://github.com/DelTa-0/codeaudit
    rev: v1.2.0
    hooks:
      - id: codeorion
```

## What it checks

- **Phantom dependencies** — packages declared or imported that don't
  exist on the live npm/PyPI registry. The most common cause is an LLM
  hallucinating a plausible-sounding package name; attackers register
  those exact names ahead of time ("slopsquatting"), so treat any phantom
  finding as urgent.
- **Suspicious dependencies** — packages that exist but look like a
  typosquat of something popular (near-name match, near-zero downloads,
  or very recently published).
- **Known-hallucinated names** — names LLMs are documented to invent, checked
  against a curated corpus even when the package *does* exist. This is the
  case every other signal reads backwards: once someone registers a
  hallucinated name, "it's on the registry" stops being reassurance, and
  downloads and age become attacker-controlled. `express-mongoose` is the
  worked example — a real npm package, 15 years old, 54 weekly downloads, and
  a documented conflation of two real packages. Every heuristic here rated it
  healthy; the corpus is what flags it. A name in the corpus is never
  reported healthy.
- **MCP server redefinition** — an MCP server whose `command` changed after it
  was introduced, found by walking the config file's git history. Approval in
  every MCP client binds to the server *name*, not to what that name runs, so
  landing an innocuous server, waiting for approval, and swapping the command
  later executes on every teammate's machine with no second prompt. No single
  revision of the file looks wrong, which is why only the change is evidence.
  Bumping a pinned version (`@1.2.2` → `@1.2.3`) is *not* a redefinition —
  comparison is on package identity, because a detector that fires on the
  healthy thing trains you to ignore it.
  Needs git history; silently skipped on an exported tarball.
- **Unused dependencies** — declared in `package.json` /
  `requirements.txt` / `pyproject.toml` but never imported anywhere in
  the repo.
- **Known vulnerabilities** — declared/resolved versions checked against
  [OSV](https://osv.dev).
- **Deprecated packages** — flagged when the maintainer has marked the latest
  version deprecated (or yanked, on PyPI). Deprecated packages stop receiving
  security fixes.
- **Licence conflicts** — copyleft dependencies (GPL/AGPL/LGPL) inside a
  permissively-licensed project, and dependencies that declare no licence at
  all. Advisory: read it as a prompt to check, not a legal opinion.
- **Duplicate libraries** — two packages that solve the same problem
  (`moment` + `dayjs`, `lodash` + `underscore`) both in use. Not a defect — a
  repo mid-migration legitimately has both — but a strong signal that
  something reached for a new library instead of reusing the one already there.
- **Dead-code candidates** — exported functions/components with zero
  call-sites in the repo. By default flagged as _candidates_ at a fixed
  confidence — static analysis only, so treat these as leads to check by
  hand, not verdicts. Supply your own LLM API key (see
  [LLM review](#llm-review-optional-bring-your-own-key) below) and the CLI
  confirms or dismisses each one with a real confidence score, the same
  review pass the hosted platform (codeaudit.madhavaryal.info.np) runs.

## Example output

```
$ npx codeorion scan .

CodeAudit · static scan of ~/projects/checkout-service

Fix first
   1. CRITICAL currency-format-pro does not exist on npm [M]
      The package cannot be installed. Hallucinated names are registered by
      attackers precisely because AI tools suggest them — treat as urgent.
      package.json
   2. CRITICAL lodash has known vulnerabilities (high) [S]
      A published advisory affects the version currently resolved. Upgrading is
      usually a version bump, which makes this a high-value, low-effort fix.
      package.json
   3. LOW      concurrently is declared but never imported [S]
      Nothing in the repository imports it. Removing it shrinks install size and
      attack surface, and is a one-line change.
      package.json

Dependencies
  phantom     currency-format-pro
  phantom     react-hooks-utils2
  unused      concurrently
  22 healthy packages not shown

Dead-code candidates (static analysis only)
  candidate  listSourceFiles  src/imports.ts:36

Score: 66 (C)  · 50 files analyzed (npm)
  security        ██████░░░░ 66
  supply chain    █████████░ 91
  maintainability ████████░░ 84
2 phantom dependencies — remove before shipping

→ Track trends, gate PRs, and get AI-reviewed findings: connect this repo at codeaudit.madhavaryal.info.np
```

**The three axes** exist because one number can't tell you which kind of
problem you have, and they prompt different reactions: a low security axis is
"stop and fix", a low maintainability axis is "schedule it". The headline is
capped by the security axis — a tidy codebase never carries a leaking one into
a good grade — so when the headline and the security axis are equal, security
is what's holding the score down.

Security counts findings absolutely; maintainability normalises by repo size,
so a large project isn't penalised for having more of everything. Each finding
removes a *fraction* of what remains rather than a fixed number of points,
which means the score never bottoms out and the second finding of a kind
always costs less than the first.

**Fix first** is the top of the output because a list of findings isn't much
use if you can't tell which one matters. It ranks by severity, then finding
kind, then confidence, then effort — so the first item is the most serious
thing you can act on, and ties break toward the cheapest fix. `[S]`, `[M]` and
`[L]` are rough effort tiers, not time estimates.

### JSON output (for CI)

```bash
npx codeorion scan . --json
```

Returns a single JSON object with `score`, `grade`, `scoreVersion`, `axes`
(`security` / `supplyChain` / `maintainability`), `counts` (per-status
tally), the full `dependencies` array, `deadCodeCandidates`, `priorities`
(the ranked fix-first list), `advisories` (`duplicates` and
`licenseConflicts`), an `upload` result (`null` unless `--upload` was
passed), and `exitCode`. Pipe it into `jq` or your CI's test-report step.

## Uploading results

By default nothing leaves your machine. If you want a CLI/CI run to show
up in your CodeAudit dashboard's scan history — useful for GitLab CI,
Jenkins, or any pipeline without GitHub webhooks — generate a per-repo
token from the dashboard (**Settings → CLI / CI uploads → Get token**),
then:

```bash
npx codeorion scan . --upload --token ca_YOUR_TOKEN
```

That's the whole command — `--api` is only needed if you self-host, since the
default already points at the hosted API.

<details>
<summary>Using an environment variable instead (CI)</summary>

The token is read from `CODEAUDIT_TOKEN` when `--token` is absent, which is
usually what you want in CI so the value lives in a secret store rather than a
command line:

```bash
# bash / zsh / GitHub Actions
export CODEAUDIT_TOKEN=ca_YOUR_TOKEN
npx codeorion scan . --upload
```

```bash
# PowerShell
$env:CODEAUDIT_TOKEN="ca_YOUR_TOKEN"
npx codeorion scan . --upload
```

</details>

Treat the token like a password (CI secret store, not source control). On
success the CLI prints the resulting dashboard URL; the run is tagged
`trigger: cli` in the same history/trend chart as webhook-triggered scans.

## LLM review (optional, bring-your-own-key)

By default, dead-code candidates are static analysis only — a fixed 0.5
confidence and no verdict. Supply your own LLM API key and the CLI performs
the same LLM-backed review the hosted dashboard does, entirely on your
machine.

**Groq** — free tier, [get a key](https://console.groq.com):

```bash
npx codeorion scan . --key gsk_YOUR_KEY
```

**OpenAI:**

```bash
npx codeorion scan . --key sk-YOUR_KEY
```

That is the whole command in both cases. A `gsk_` or `sk-` prefix identifies
its provider unambiguously, so the endpoint and a sensible default model are
filled in for you. Add `--model` to override the default.

**Anything else** — a local Ollama, a self-hosted proxy, Anthropic behind an
OpenAI-compatible shim — needs the endpoint and model spelled out, because the
CLI will not guess a provider you did not name:

```bash
npx codeorion scan . --key YOUR_KEY --url http://localhost:11434/v1 --model llama3
```

Your key is used only in the request to the endpoint you configured: it is
never included in `--json` output, never sent as part of `--upload`, and never
written to disk.

With a key configured, dead-code candidates get real confidence scores and
reasoning, and phantom-package findings with no offline spelling match may
get an AI-suggested real alternative (e.g. `fastimagepro` → Pillow/imageio).

## Guarding against phantom packages _before_ they land

Running the scanner after the fact catches phantoms already committed.
To stop an AI coding agent from installing one in the first place, see
[`codeorion-mcp`](https://github.com/DelTa-0/codeaudit/blob/main/mcp/README.md)
— an MCP server that checks a package name the moment an agent is about
to install it.

## Links

- [Full CodeAudit docs](https://github.com/DelTa-0/codeaudit) — webhook
  auto-scans, merge gates, auto-fix PRs, AI-authorship metrics, README
  badges
- [codeaudit](https://github.com/DelTa-0/codeaudit) — connect a repo for LLM-reviewed
  findings and trend tracking

## License

MIT
