---
type: plan
title: "Accuracy, Usefulness & Security Roadmap (competitor-informed)"
created: 2026-08-11
updated: 2026-08-11
tags:
  - project/codeaudit
  - planning
status: proposed
related:
  - "[[roadmap]]"
  - "[[about]]"
---

# Accuracy, Usefulness & Security Roadmap

Competitor-informed feature plan written 2026-08-11 to make CodeOrion more
accurate and more useful ahead of internship evaluation. Research base:
Socket.dev, Snyk, Semgrep, Endor Labs, Knip/depcheck, OpenSSF Scorecard,
mcp-scan (Snyk Agent Scan), and **Strix** (`usestrix/strix`, autonomous AI
pentesting for vibe-coded apps).

## Strategic framing

Do **not** try to become Strix (dynamic, agentic PoC-validated pentesting —
needs code execution, breaks our "never run the target" guarantee, and is a
category they already own with ~39K stars). Instead position CodeOrion as the
**static, zero-config, agent-time guardrail** that catches vibe-coding
security mistakes at the moment of writing/installing — complementary to a
runtime pentester like Strix. Lead the evaluation narrative with that
complementary positioning, not a feature-count comparison.

Strix's real lesson for us: it finds *application-code* vulnerabilities (SQLi,
XSS, SSRF, secrets, broken auth) that vibe coders actually ship. We currently
only audit dependency hygiene, dead code, secrets, and agent configs. That
application-code gap is the #1 thing an evaluator judging "security of
vibe-coded apps" will notice — hence Phase 2.

## Phase 1 — Evaluation credibility (do first)

1. Deploy the SaaS to a real URL with a seeded read-only demo org; link at top
   of README. (See the separate AWS ECS/ECR readiness assessment.)
2. GitHub Actions CI running the 6 existing test suites + builds, with a badge.
3. Publish a `codeorion` GitHub Action (diff-scoped, like Strix's
   `--scope-mode diff`) for one-line CI adoption.

## Phase 2 — Application-code security scanning (Strix-inspired pivot)

4. Static detectors for top vibe-coding vuln classes — pattern/AST-based, no
   code execution (safety posture holds). Start with 6–8 high-precision rules:
   - Hardcoded secrets in code (surface existing `scan_secrets` in the repo
     scan pipeline, not just the MCP write-guard).
   - SQL/command injection: concatenated/template-literal queries into
     `query()`/`exec()`/`child_process`/`os.system`; f-string SQL in Python.
   - SSRF: user input into `fetch`/`axios`/`requests`/`urllib`.
   - XSS sinks: `dangerouslySetInnerHTML`, `eval`, `innerHTML`, `v-html`.
   - Insecure config: wildcard CORS with credentials, disabled TLS
     verification, `DEBUG=true` shipped, missing auth middleware.
   Reuse `@babel/parser` + the Python analyzer as AST-visitor rules
   (Semgrep-style). This is a credible SAST v1.
5. Evidence-first findings (static analog of Strix's PoC): every code finding
   shows file:line, the tainted expression, a one-line "why exploitable", and
   remediation — never a bare rule name.

## Phase 3 — Accuracy (the false-positive story Strix owns via PoC)

6. Finding suppression + baseline diffs: `.codeorionrc` ignore list honored by
   CLI + server; dashboard dismiss-with-reason (audit-logged); PR comments
   report only findings new since the base scan (mirrors `--diff-base`).
7. Coarse reachability tiering for CVEs: directly-imported /
   transitively-required / declared-but-unimported, weighted into the score
   ("critical CVE, never imported → informational"). Reuses import graph +
   lockfile tree.
8. Framework-aware entry points (Knip lesson): Next.js/Vite/Express/pytest
   roots aren't dead-code candidates. Kills the dominant historical FP class.
9. Known-hallucination list complementing Damerau-Levenshtein (e.g.
   `unused-imports`, the Jan 2026 `react-codeshift` incident).

## Phase 4 — Agent-time depth (extends the niche Strix's SKILL.md validates)

10. Package health signals via OpenSSF Scorecard + deps.dev (maintenance,
    `deprecated`, `preinstall`/`postinstall` install-script detection). Free,
    keyless, CLI-compatible.
11. SBOM (CycloneDX) + SARIF export → GitHub code scanning; license column
    from registry metadata already fetched.
12. MCP rug-pull detection in `codeorion-mcp`: hash-pin tool descriptions on
    first sight, warn on change (marquee mcp-scan feature not yet covered).

## Ordering rationale

Phase 1 changes an evaluator's first five minutes. Phase 2 is the new center
of gravity — it answers "what does this do for the *security* of vibe-coded
apps." Phases 3–4 are highest accuracy-per-effort because they reuse existing
infrastructure. Everything stays static and keyless, preserving the "never
execute the target / zero-config degradation" principles.

Opportunistic existing open items to fold in: `XAI_*`→`GROQ_*` rename, SSE
instead of 2s polling, route-level integration tests.
