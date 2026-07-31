---
type: reference
title: "Engineering Intelligence Phase 1 — Signal design"
created: 2026-07-31
status: approved
related:
  - "[[roadmap]]"
  - "[[architecture]]"
  - "[[decisions]]"
  - "[[known-issues]]"
---

# Engineering Intelligence — Phase 1 "Signal"

## Context: how this scope was chosen

A 21-feature "Engineering Intelligence Platform" brief was evaluated feature by
feature against technical fit, product value, engineering complexity, and
differentiation. **Twelve of the twenty-one were rejected or postponed.** That
is not under-delivery — the brief itself says "do not optimize for having the
most features" and "whenever there is uncertainty, choose simplicity, evidence,
maintainability." Cutting is compliance with it.

### Rejected, with reasons

| Feature | Reason |
|---|---|
| Debt cost estimation (hours/$) | Any hours figure is a made-up constant × finding count. We don't know salary, seniority, or codebase familiarity. Replaced by S/M/L effort tiers inside prioritization — ordering information without fake precision. |
| AI-vs-human code quality | Already litigated in [[roadmap]] (2026-07-21) and reworked: the comparison is **confounded by code age**. AI is pointed at newer code, and newer code carries more not-yet-cleaned-up debt regardless of author. Rebuilding it repeats a documented mistake. |
| Repository knowledge graph | Infrastructure, not product. Users buy answers, not graphs. The useful 20% (file-level import graph) falls out of Architecture Intelligence for free. |
| Codebase explanation | Generate-once, never-reopen. Doesn't drive daily use, and competes head-on with IDE agents doing it free. |
| Engineering team intelligence | Once per-engineer debt attribution exists in the database, someone queries it as a ranking regardless of what the UI shows. Also re-imports the code-age confound. Developer trust is the distribution channel (CLI + MCP); a tool that scores individuals loses it. **The privacy-preserving version of this feature is not building it.** |
| Engineering velocity causality | "Why velocity is slowing" is a causal claim from correlational git metadata. Churn and hotspot *trends* are the honest version and partly exist already. |
| "Business risk" score dimension | No business context exists in the system to support it. |
| Auth/authz analysis | Semgrep's turf, high false-positive rate. The brief says complement, don't duplicate. |

### Postponed, blocked on data or prerequisites

- **Debt forecast** — needs months of scan history that does not exist yet.
- **Repository benchmarking** — needs a corpus of scans, i.e. a user base.
- **Refactoring planner** — blocked on Architecture Intelligence + AI Reviewer.
- **Performance intelligence** — mostly guesswork without execution; "duplicate
  libraries" and "heavy packages" salvaged into Dependency Intelligence.
- **General hallucinated-API detection** — see "Deliberately not in scope".

### The resulting phase plan

| Phase | Contents | Status |
|---|---|---|
| 0 — Reachability | Deploy target + CI | **Blocking, not yet scoped** |
| **1 — Signal** | **Prioritization · Dependency Intelligence · Secrets** | **This spec** |
| 2 — Memory | Finding fingerprints → Timeline · PR Impact · Risk dimensions | Next |
| 3 — Depth | Duplication · error-masking · architecture intelligence · AI-workflow security | Later |
| 4 — Explanation | AI Reviewer · release readiness (improve merge gate) | Later |

**Phase 0 is genuinely blocking and is not addressed by any of the 21
features.** Per [[architecture]], CodeAudit runs only on localhost with no
deployment target and no CI/CD. The brief's goal — "teams use it every day" —
is unreachable while nobody can reach the product. Phase 1 makes the product
better; it does not make it available.

---

## Problem

CodeAudit produces findings but offers no opinion about which matter. A scan
can emit hundreds of rows across five dependency statuses plus up to 40
dead-code candidates, presented as flat category cards. An engineer opening the
dashboard cannot tell what to do first.

Separately, three high-value, low-cost signals are missing entirely: hardcoded
secrets, deprecated/licence-conflicting dependencies, and redundant duplicate
libraries — all of which are either already in data we fetch, or cheap pure-static
computation.

## Goal

Make existing findings **actionable** and add the three cheapest high-value
detectors, without new subsystems and without restructuring the pipeline.

Every item in this phase satisfies: solves a real problem · fits the existing
architecture · maintainable · scales · measurable value.

## Deliberately not in scope

- **Hallucinated API/SDK-method detection.** To know `s3.uploadFileAsync()` is
  fake requires real API surfaces. The security rule in [[decisions]] forbids
  installing dependencies, and using an LLM to guess is hallucination detecting
  hallucination — precisely what the brief forbids ("never hallucinate
  detections"). A safe evidence path exists (fetch a package's `.d.ts` from the
  registry tarball without executing it) but is its own project.
- **Score dimensions, timeline, duplication detection** — Phases 2 and 3.

---

## Architecture

Three additions, all hooking into the existing
`verdicts → findings → score → PR comment → badge` pipeline. No pipeline
restructuring.

```
                     ┌─ registry.ts (extended: deprecated/licence/size)
analyzeRepo ─────────┤
  (existing pass)    └─ duplicates.ts   (new, pure)
                        secrets.ts      (new, pure detection)
                        priority.ts     (new, pure ranking — runs last)

server/analysis/historySecrets.ts (new, git plumbing → calls secrets.ts)
```

**Engine purity is preserved.** `packages/engine/` stays LLM-free,
heavy-dependency-free, and **subprocess-free**. Secret *detection* is a pure
function in the engine; the *git plumbing* for history scanning lives
server-side in `server/src/analysis/`, mirroring the existing precedent of
`aiAuthorship.ts`. This keeps the CLI bundle unchanged in character and lets the
CLI reuse detection today and add its own git plumbing later.

---

## Feature 1 — Intelligent prioritization

### Why it matters

Highest value-to-effort ratio in the entire 21-feature brief. Pure sort over
findings that already exist; it is the difference between a tool and a wall of
noise.

### Design

New `packages/engine/src/priority.ts`:

```ts
rankFindings(deps, codeFindings, secrets, opts) → RankedFinding[]
```

Each `RankedFinding` carries `severity`, `confidence`, `effort`, `rank`, and a
mandatory **`why`** string. An unexplained rank is just a differently-shaped
wall of noise, and the brief requires every score to explain itself.

**Severity** is intrinsic to finding type, ordered:
hardcoded secret → phantom dependency → critical/high CVE → typosquat-suspicious
→ licence conflict → deprecated → duplicate library → unused dependency → dead code.

**Confidence** already exists on code findings (LLM-assigned); dependency
verdicts are deterministic at `1.0`.

**Effort** is S/M/L, *derived not invented*:

| Effort | Cases |
|---|---|
| S | Remove unused dep (one line) · remove dead export · CVE where OSV reports a fixed version |
| M | Replace phantom dep · consolidate duplicate libraries · rotate a secret still in HEAD |
| L | CVE with no fixed version · licence conflict requiring a dependency swap · secret already published in git history |

This is what replaces the rejected dollar-cost feature: ordering information
with honest precision, no fabricated currency.

**Ordering is lexicographic, not a weighted formula** — sort by severity band,
then by confidence descending, then by effort ascending (cheapest fix first
within a tier). A weighted sum would require magic coefficients that nobody can
justify or explain, which would reintroduce the same fake-precision problem that
got cost estimation rejected. Lexicographic ordering is trivially explainable:
"secrets before phantom deps; within a tier, most certain first; among equals,
cheapest first."

**Output is capped at the top 20** into `summary.priorities`; everything else
remains available through the existing paginated findings endpoints. This
directly satisfies "never dump hundreds of findings."

Ranking is **computed at scan time, not stored as columns**, so the ranking
formula can change without a schema migration.

---

## Feature 2 — Dependency intelligence

### Why it matters

Best effort-to-value ratio after prioritization, because nearly all of it is
metadata **already being downloaded and discarded**.

`registry.ts:151` fetches the full npm packument and reads only three fields
(`time.created`, `dist-tags.latest`, downloads). That same document already
contains `versions[latest].deprecated`, `.license`, and `.dist.unpackedSize`.
Deprecation, licence, and package weight therefore cost **zero additional HTTP
requests**.

### Design

**Deprecated packages** — read `versions[latest].deprecated` (npm) and
`info.yanked` / `Development Status :: 7 - Inactive` classifiers (PyPI). npm's
deprecation message usually names a successor ("use X instead"); parse it into a
migration hint.

**Licence conflicts** — read the project's own licence from `package.json` /
`LICENSE`, then flag copyleft (AGPL/GPL/LGPL) dependencies inside a permissive
project, and flag dependencies with no licence at all. Also directly relevant to
EU Cyber Resilience Act obligations beginning 2026-09-11.

**Duplicate libraries** — new `packages/engine/src/data/equivalents.ts`,
following the `data/popular.ts` precedent exactly (committed TS module, offline,
deterministic, bundles into the esbuild CLI with no asset-copy step). Groups:
date (`moment`/`dayjs`/`date-fns`/`luxon`), utility (`lodash`/`underscore`/`ramda`),
http (`axios`/`node-fetch`/`got`/`superagent`), state
(`redux`/`zustand`/`jotai`/`mobx`), test (`jest`/`vitest`/`mocha`/`ava`).

Fires only when **two or more members of a group are both declared and
imported**. Severity stays low and the framing is "consolidation opportunity" —
a repo mid-migration legitimately has two, and this is a strong "an agent added
a new library instead of reusing the existing one" signal rather than a defect.

**Heavy packages** — `versions[latest].dist.unpackedSize`, flagged only when a
lighter equivalent exists in the same group.

### Where findings live

Per-package facts (`deprecated`, `license`, `unpackedSize`) ride the existing
`registryMetadata` JSONB — the annotate-don't-invent pattern already established
for typosquat in [[decisions]].

Duplicate-library and licence findings are **set-level relationships, not
package properties** ("you have both moment and dayjs"), so they live in
`summary.advisories`. No per-package row can express them.

---

## Feature 3 — Secrets detection (HEAD + git history)

### Why it matters

The single largest missing check. LLMs hardcode credentials constantly — it is
the canonical AI-generated-code mistake — and a committed live key is arguably
more urgent than any other finding CodeAudit produces.

**Differentiation note, stated honestly:** GitHub offers secret scanning, and
this does not out-detect it. The value here is integration — secrets feed the
health score, the prioritized fix-first list, the merge gate, and the PR
comment, and the detection runs offline in the CLI on private code with no
GitHub Advanced Security licence.

### Detection design — precision first, three tiers

**Tier 1 — known provider prefixes** (near-zero false positive):
`sk-ant-`, `gsk_`, `ghp_`/`gho_`/`ghs_`/`github_pat_`, `AKIA`, `AIza`,
`xox[baprs]-`, `sk_live_`/`pk_live_`, `SG.`, `npm_`, `glpat-`, `dop_v1_`,
and `-----BEGIN … PRIVATE KEY-----`.

**Tier 2 — contextual entropy**: an identifier matching
`/(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key)/i`
assigned a string literal with Shannon entropy above threshold and length ≥ 16.
Starting threshold 4.0 bits/character, tuned against the ground-truth fixtures
during implementation — the lockfile-integrity-hash and base64-asset cases are
the ones that set the real floor.

**Tier 3 — exclusions.** This is where precision is actually won, and it is
tested harder than the detection tiers:

- `.env.example`, `*.sample`, `*.template`, `*.example`
- test and fixture directories (reuse `deadcode.ts` patterns)
- placeholders: `your-`, `changeme`, `<…>`, `xxx`, `placeholder`, `dummy`,
  repeated-character runs
- **values that are `process.env.X` / `os.environ[...]` references** — that is
  the *correct* pattern, not a finding
- **lockfiles** — integrity hashes are maximally high-entropy and would
  otherwise fire on every line
- minified and generated files

### File coverage

Secrets need their **own file walk**: `listSourceFiles` only covers JS/TS
extensions, but credentials hide in `.env`, `.yml`, `docker-compose.yml`,
`.tf`, `.json`, `.ini`. Same skip-directories and same size caps as the existing
walk.

### Git history scanning

A secret removed from HEAD is **still in the git objects and still
compromised**. Deleting the line does not help; anyone who cloned has it. This
is the finding class that HEAD-only scanning structurally cannot produce, and
it is why history scanning is in scope.

`server/src/analysis/historySecrets.ts`:

1. Run `git log -p --unified=0 --no-color --max-count=100` (matching the clone
   depth `aiAuthorship.ts` already establishes).
2. Stream-parse, tracking the current commit SHA and current file, scanning
   **added (`+`) lines only** — every secret ever introduced appears as an
   added line at some point, so this is complete without scanning full trees.
3. Apply the same engine detector and the same exclusion list per line.
4. **Deduplicate** by `(provider, redactedFingerprint)` — one finding with
   `firstSeenCommit` and `lastSeenCommit`, not one per commit.
5. Cross-reference against the HEAD scan. If a fingerprint is **absent from
   HEAD**, mark `removedFromHead: true` and change the recommendation from
   *"remove this line"* to **"rotate this credential"** — the only correct
   advice, since the value remains in history.

Caps: 100 commits, output byte cap, subprocess timeout — consistent with the
existing 60s/200MB/20k-file clone limits. Best-effort and null-on-failure, like
the rest of `analysis/`.

### Redaction is an architectural constraint, not a detail

**A secrets scanner that stores secrets is a liability, not a feature.** One
choke-point function applied before *any* egress:

- Never persist the value — store provider type, file, line, and a redacted
  shape (`gsk_…`, 56 chars) plus a non-reversible fingerprint for dedupe
- **Never send to the LLM.** Repo content already goes to Groq for zombie
  review; secrets must be stripped from anything on that path
- Never include in `--upload` payloads
- Never echo in CLI output, PDF/Word export, or **PR comments**

The PR-comment path is the sharp edge: **comments are public on public
repositories**, so an unredacted secret finding would publish a live credential
to the internet. Redaction there is a correctness requirement, not hygiene.

---

## Scoring changes

Staged deliberately, because adding penalties silently moves every repo's score
and a merge gate configured at 70 could begin failing on unchanged code.

**Scores immediately** — hardcoded secrets. Unambiguous and critical:
`−20` each, capped at `−40`.

**Advisory-only for one release** — deprecated, licence conflict, duplicate
library. Visible as findings, zero score impact. Weighted in a follow-up once
real-world output has been observed.

This preserves the property from [[decisions]] that CLI-computed scores stay
comparable to hosted ones: all three detectors run identically in both, and
history scanning (server-only in this phase) is advisory, not scored.

---

## Database changes

**One additive, nullable migration** — `004_finding_detail.sql`:

```sql
ALTER TABLE code_findings ADD COLUMN detail JSONB;
```

An earlier draft of this design claimed zero migrations. Adding git-history
scanning invalidated that: a history finding carries a commit SHA, which has no
home in `code_findings`. Overloading `llm_reasoning` with structured data to
preserve the "zero migrations" claim would be cleverness at the cost of clarity.

Everything else remains migration-free:

- Secrets ride `code_findings` with `finding_type = 'hardcoded_secret'` — the
  column is unconstrained TEXT, the same property that let `vulnerable` be added
  to `dependency_findings.status` with no migration
- Per-package dependency facts ride `registryMetadata` JSONB
- Rankings and set-level advisories ride `scan_jobs.summary` JSONB

## API changes

**No new endpoints.** The ranked list and advisories ride `summary` JSONB, so
the dashboard, PR comment, badge, and CLI all read one source of truth and stay
consistent by construction.

## Worker changes

Three additional calls in `server/src/worker.ts`, at the same pipeline position
as the existing `findDeadCodeCandidates`, plus the history-secrets call
alongside the existing `aiAuthorship` invocation. No restructuring.

## Background jobs

None added. All work runs inside the existing scan job. The PR-comment queue is
unchanged apart from its rendering template.

## UI changes

- **New "Fix first" card** at the top of `ScanDetail.tsx` — the ranked list with
  `why` text and S/M/L effort badges. This becomes the primary thing a user sees.
- **Secrets card**, critical styling, values redacted, with rotate-vs-remove
  guidance driven by `removedFromHead`.
- Deprecated / licence badges on existing dependency table rows.
- **"Consolidation opportunities"** card for duplicate-library groups.
- Existing category cards remain. Improve, don't replace.
- PR comment leads with the top 3 ranked items rather than the current category
  tally.
- CLI gains a "Fix first" section at the top, with secrets redacted.

## Performance considerations

- **Zero added HTTP latency** for dependency intelligence — the fields come from
  packuments already downloaded.
- Secrets adds a second file walk over a broader extension set; bounded by the
  same size and count caps. Expected to be a small fraction of existing parse time.
- History scanning is one `git log -p` subprocess, streamed, byte-capped and
  timeout-bounded at 100 commits.
- Prioritization, duplicate detection and licence checks are in-memory passes
  over arrays that already exist — negligible.
- *Noted follow-up, not in scope:* switching to npm's abbreviated packument
  (`Accept: application/vnd.npm.install-v1+json`) would cut bandwidth
  substantially, since full packuments for popular packages run to megabytes.

## Security considerations

- Redaction choke point, as described above — the dominant concern.
- No new subprocess execution in the engine; the single new subprocess
  (`git log`) is server-side, argument-fixed, with no user-controlled input
  interpolated into the command.
- No new network egress.
- Secrets must be stripped from any payload on the LLM path.
- Public-repo PR comments must never carry a value.

## Testing

Extend `server/test/ground-truth.ts`, following the existing fixture pattern.
**The must-NOT-fire cases matter more than the must-fire cases**, per the
false-positive history documented in [[roadmap]]:

- Secrets: real-shaped AWS key in source **fires**; same key in `.env.example`
  **does not**; lockfile integrity hash **does not**; `process.env.KEY`
  **does not**; `your-api-key-here` **does not**
- History: a key added then deleted **fires** with `removedFromHead: true`; the
  same key across 20 commits produces **one** finding, not 20
- Duplicates: `moment` + `dayjs` both imported **fires**; `moment` alone **does not**
- Deprecated: a known-deprecated package fires
- Licence: an AGPL dependency in an MIT project fires
- Prioritization: ordering assertions — a secret outranks a phantom dependency,
  which outranks an unused dependency
- Redaction: no test fixture's raw secret value appears in any serialized
  output (findings JSON, upload payload, PR comment body, exported report)

## Estimated implementation effort

~2 weeks solo.

| Component | Effort |
|---|---|
| Prioritization | 1 day |
| Dependency intelligence | 2 days |
| Secrets — HEAD | 2 days |
| Secrets — git history | 2 days |
| UI / PR comment / CLI surfacing | 2 days |
| Tests + fixtures | 1.5 days |

## Risks

1. **Secrets false positives destroy trust on first contact.** Exactly the
   failure mode the Python analyzer already taught ([[roadmap]], 2026-07-20).
   Mitigated by prefix-first ordering, and by testing the exclusion list harder
   than the detection list.
2. **Score shifts break existing merge gates.** Mitigated by the staged scoring
   split above.
3. **Redaction leak.** Highest-severity risk in the phase. Mitigated by a single
   choke-point function with explicit serialization tests.
4. **Curated list drift** (equivalents, provider prefixes). Kept small,
   committed, and documented — same posture as `popular.ts`.
5. **History scanning on large repos** could produce large `git log` output.
   Mitigated by byte cap, commit cap, and timeout; degrades to null like the
   rest of `analysis/`.

## Future improvements

- CLI-side git-history scanning (needs its own git plumbing; detection already
  shared)
- Weight the advisory findings into the score after one release of observation
- Abbreviated-packument bandwidth optimization
- Push-protection-style pre-commit hook reusing the same detector
- Feed secrets and licence findings into the MCP surface so agents can check
  before writing

## Phase 1 checklist

- [ ] `priority.ts` with `why` + S/M/L effort, capped at 20
- [ ] `registry.ts` extended: deprecated, licence, unpackedSize (no new requests)
- [ ] `data/equivalents.ts` + `duplicates.ts`
- [ ] Licence conflict detection against project licence
- [ ] `secrets.ts` — tiers 1–3, own file walk
- [ ] Redaction choke point + serialization tests
- [ ] `004_finding_detail.sql`
- [ ] `analysis/historySecrets.ts` + dedupe + `removedFromHead`
- [ ] Worker wiring
- [ ] "Fix first" card, secrets card, consolidation card, dependency badges
- [ ] PR comment leads with top 3; redacted
- [ ] CLI "Fix first" section; redacted
- [ ] Ground-truth suite extended
- [ ] **Bump + publish `codeaudit-scan` in the same change** — per the
      publish-drift lesson in [[roadmap]], an engine fix is not done until the
      published package reflects it
