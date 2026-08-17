---
type: feature
title: "M6 — AI Risk & Agent Security"
created: 2026-08-17
updated: 2026-08-17
tags:
  - project/codeaudit
  - milestone
status: developing
related:
  - "[[../index]]"
  - "[[../architecture]]"
  - "[[../decisions]]"
  - "[[../database-schema]]"
---

# M6 — AI Risk & Agent Security

## What it delivers

The second pillar of the product. M1–M5 built a code-health scanner; this
turns it into something a generic debt scanner cannot be: an audit of the AI
development surface itself — what an assistant introduced, what it can reach,
and what changed since anyone last looked.

Five pieces shipped so far, in the order they were built. That order was
chosen deliberately, and differs from the order originally proposed: the debt
delta was moved *after* the finding lifecycle, because "resolved: −2" is not
computable without stable finding identity.

## 1. Attribution honesty

**`server/src/analysis/aiAuthorship.ts`**

AI authorship is inferred from `Co-Authored-By` trailers and bot author names.
That is high precision and **low recall**: a trailer proves an assistant was
involved, but Copilot inline completion, Cursor tab-completion and pasted chat
output leave nothing in git.

So "no AI found" and "AI used without recording it" are the same observation,
and any surface rendering both as 0% asserts something the data cannot
support. `computeAiAuthorship` now returns an `attribution` block —
commits examined, markers found, whether history was truncated, a `level`
(`none | low | usable`), and a server-authored `caveat` sentence rendered
verbatim everywhere so the dashboard, PR comments and exports cannot drift
apart.

`level` is the gate every downstream AI claim consults. **`none` must render
as UNAVAILABLE, never as zero risk.**

This also surfaced a live mismatch: `aiAuthorship` asked git for 500 commits
while the clone is `--depth 100`, so it could only ever see 100. Truncation is
now detected and reported rather than assumed away.

## 2. Finding lifecycle

**`packages/engine/src/findingIdentity.ts`, `server/src/services/findingLifecycle.ts`, migration `006`**

Findings used to exist only inside the scan that produced them. The product
could say "6 unused dependencies" but never "this has been open since the 1st"
or "you fixed this and it came back".

The hard part is identity, not storage. Keys name the *problem*, not the
observation of it, so line numbers, confidence scores and versions are
excluded — they change constantly without the problem changing:

| Kind | Key | Why |
|---|---|---|
| dependency | name + ecosystem + **status** | "axios is unused" and "axios has a CVE" have different fixes; merging them would reclassify a finished cleanup as an open vulnerability |
| dead code | file + symbol, **not** findingType | a symbol that stops being exported is the same dead symbol |
| secret | fingerprint only | a leaked credential is leaked wherever it lives, so identity survives a file move |
| agent config | file + rule, **not** line | keying on line would resurrect it on every edit above it |

Known limitation: a renamed file reads as one resolved + one new. Content
hashing would avoid that but churn on every edit to the code itself — a rare
wrong answer traded for a constant one.

`reconcileFindings` returns `new / resolved / reintroduced / persisting`.
**Reintroduced is tracked separately on purpose**: a returning finding is a
regressed fix, and counting it as "new" hides that the fix failed.

The state machine's real constraint: **a scan must never overwrite a human
decision.** `ignored` and `acknowledged` rows record their sighting but keep
their state, and the resolve sweep only touches `open`. Otherwise dismissing a
false positive would last until the next push.

## 3. Debt delta

**`web/src/pages/ScanDetail.tsx`, `server/src/queue/prComment.ts`**

A score delta cannot answer the reviewer's question. "82 → 76" could be one
new vulnerability or four dead-code candidates, and cannot show that anything
was fixed. Both surfaces now lead with new / reintroduced / resolved / open
total, and a reintroduction escalates the PR recommendation on its own.

`buildPrCommentBody` was extracted so the most attacker-visible output in the
product — package names, file paths and LLM reasoning, posted publicly on a
PR — has a regression guard on its escaping for the first time.

## 4. Dependency attribution

**`server/src/analysis/dependencyAttribution.ts`**

Every dependency gets its introducing commit, author, commits-ago and a
three-valued AI verdict. Walks each manifest's history once and diffs the
dependency set between revisions — `git log -S<name>` per package would be one
process spawn per dependency.

The verdict is three-valued for the reason established in part 1:
**`unlikely` is claimed only when the repository's attribution level is
`usable`.** Where nothing is marked, an unmarked commit is not evidence of a
human, so the answer is `unknown`.

Dependencies present at the oldest visible commit are marked
`predatesHistory` and claim nothing at all — with a depth-100 clone that means
"older than our window", never "original".

## 5. Agent attack surface

**`packages/engine/src/agentSurface.ts`**

`agentConfig.ts` answers "is anything here malicious". This answers the prior
question — what is there at all. Inventories instruction files, skills,
permission files and every MCP server, then rates each server.

**What it refuses to claim is the design.** An MCP config declares a command
to run; it does not declare what that command does once running. Only what the
invocation shows is reported: shell execution, filesystem paths handed over as
arguments, and unpinned packages. **Network access is deliberately not
reported** — nothing in a config can show it, and a badge inferred from a
server's name would be a guess wearing the costume of a finding.

Shell is the only single fact rated HIGH alone: it turns a config entry into
an execution primitive.

The score is driven by findings, never inventory size — penalising surface
area would push teams toward hiding configuration rather than fixing it.

## Related: scoring v2 and MCP redefinition

Two changes that landed alongside and are documented in
[[../decisions]]:

- **Scoring v2** — three axes composed multiplicatively, headline capped by
  the security axis. The single additive budget of v1 is what made every new
  detector a breaking change, which is why agent config had shipped at
  `score -= 0`.
- **`mcp_server_redefined`** — an MCP server whose command changed after it was
  introduced. Invisible in any single revision, because approval binds to the
  server's *name*, not to what it runs.

## Tests

| Suite | Checks |
|---|---|
| `test:finding-lifecycle` | 24 — needs Postgres; the behaviour under test *is* the SQL |
| `test:agent-surface` | 15 — including the refusal to invent network claims |
| `test:dependency-attribution` | 12 — builds a real git repository |
| `test:pr-comment` | 10 — delta rendering + markdown-forgery escaping |

Plus the attribution-coverage and finding-identity checks folded into
`test:ground-truth`.

## Not done

- **AI Risk score** — deliberately last. Restricted to the AI-attributed
  subset it would mean something; computed over everything it would just be
  the health score again under a different name. It is only computable where
  attribution coverage is `usable`, which needs a product decision about what
  to show everywhere else.
- **Backfill** — lifecycle rows accumulate from the next scan onward. Existing
  scan history has no identity keys, so "first detected" starts from now.
- **Migration 006 in production** — until it runs, reconciliation fails
  silently (best-effort) and no deltas appear.
