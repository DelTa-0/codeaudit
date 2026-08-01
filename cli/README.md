# codematrix

A local, static scanner for AI-generated technical debt in JS/TS and Python
repos — phantom (hallucinated) dependencies, suspicious/typosquat packages,
unused dependencies, and dead-code _candidates_. No account, no signup,
nothing leaves your machine unless you opt in with `--upload`.

This is the CLI half of [CodeAudit](https://github.com/DelTa-0/codeaudit).
It's deliberately limited to static analysis — no LLM review, no scan
history, no PR integration. Those live in the full platform at
[codeaudit.dev](https://codeaudit.dev); the CLI is the free, offline way to
try the core checks first.

## Quick start

No install needed — run it straight from your repo root with `npx`:

```bash
npx codematrix scan .
```

That's it. It detects whether the repo is npm, PyPI, or both (polyglot
repos get scanned on both ecosystems in one pass), checks every declared
dependency against the live npm/PyPI registries, and flags exported
symbols with zero call-sites as dead-code candidates.

Prefer a permanent install? `npm install -g codematrix` then run
`codematrix scan .` directly — same behavior, just skips npx's
resolve-on-every-run step.

## Usage

```
codematrix scan [dir] [options]
```

`dir` defaults to `.` (the current directory).

| Option          | Description                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--json`        | Machine-readable output — one JSON object on stdout, for CI parsing                                                           |
| `--min-score N` | Exit `1` if the health score is below `N`                                                                                     |
| `--upload`      | Send results to your CodeAudit dashboard (requires a token; see [Uploading results](#uploading-results))                      |
| `--token T`     | Per-repo CLI token for `--upload` (or set `CODEAUDIT_TOKEN`)                                                                  |
| `--api URL`     | API base URL for `--upload` (or set `CODEAUDIT_API_URL`; defaults to `http://localhost:4000`, only relevant if you self-host) |
| `-h`, `--help`  | Show usage                                                                                                                    |

### Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `0`  | Clean — no phantom dependencies, score at/above `--min-score` if set |
| `1`  | Phantom dependencies found, or score below `--min-score`             |
| `2`  | Usage error or scan failure                                          |

Use the exit code directly as a CI gate:

```bash
npx codematrix scan . --min-score 80
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
  call-sites in the repo. Flagged as _candidates_ at a fixed confidence:
  the CLI does static analysis only, so treat these as leads to check by
  hand, not verdicts. The platform's LLM review pass (codeaudit.dev)
  confirms or dismisses each one with a confidence score.

## Example output

```
$ npx codematrix scan .

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
2 phantom dependencies — remove before shipping

→ Track trends, gate PRs, and get AI-reviewed findings: connect this repo at codeaudit.dev
```

**Fix first** is the top of the output because a list of findings isn't much
use if you can't tell which one matters. It ranks by severity, then finding
kind, then confidence, then effort — so the first item is the most serious
thing you can act on, and ties break toward the cheapest fix. `[S]`, `[M]` and
`[L]` are rough effort tiers, not time estimates.

### JSON output (for CI)

```bash
npx codematrix scan . --json
```

Returns a single JSON object with `score`, `grade`, `counts` (per-status
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
CODEAUDIT_TOKEN=ca_xxxxx npx codematrix scan . --upload
```

Treat the token like a password (CI secret store, not source control). On
success the CLI prints the resulting dashboard URL; the run is tagged
`trigger: cli` in the same history/trend chart as webhook-triggered scans.

## Guarding against phantom packages _before_ they land

Running the scanner after the fact catches phantoms already committed.
To stop an AI coding agent from installing one in the first place, see
[`codematrix-mcp`](https://github.com/DelTa-0/codeaudit/blob/main/mcp/README.md)
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
