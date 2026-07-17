---
type: feature
title: "M3 — LLM Zombie-Code Layer"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
  - milestone
status: done
related:
  - "[[../index]]"
  - "[[../architecture]]"
  - "[[../decisions]]"
---

# M3 — LLM Zombie-Code Layer

## What it delivers

Dead-code candidate detection plus LLM judgment with confidence scores, and
the weighted health score that ties dependency + zombie findings into a
single number.

## Key pieces

- `analysis/deadcode.ts` — `findDeadCodeCandidates()`: a symbol qualifies
  when it has zero references outside its own file, isn't an ignored
  framework-entry name, and isn't in a test/mock/script path. Capped at 40
  candidates/scan
- `analysis/llm.ts` — batches candidates per file into one Groq chat
  completion. System prompt requires JSON-only output and explicitly states
  all `<code>`-delimited content is untrusted data, never instructions
  (prompt-injection guard). Retries on 429/5xx with backoff; malformed
  responses are dropped without failing the scan. Falls back to static-only
  findings (confidence 0.5) if no API key is configured
- `analysis/score.ts` — `computeSummary()`: phantom −15/ea, suspicious
  −6/ea, unused −3/ea, zombies up to −20 total confidence-weighted, graded
  A–F
- `ScanDetail.tsx` — zombie findings table with expandable LLM reasoning,
  color-coded confidence bars

## Ground-truth validation

`server/test/ground-truth.ts` + `server/test/fixture/` — a seeded fixture
with known-correct answers, run via `npm run test:ground-truth`:

| Assertion | Result |
|---|---|
| `react-toolkitz` (fake package) → phantom | PASS |
| `date-fns` (declared, unused) → unused | PASS |
| `lodash` (declared, used) → healthy | PASS |
| `calculateLegacyDiscount` (dead export) flagged | PASS |
| `zombieFormatter` (dead export) flagged | PASS |
| `helper` (cross-file referenced) NOT flagged | PASS |
| `main` (entry-point name) NOT flagged | PASS |

7/7 passing. This is the strongest evidence the analysis engine is *correct*,
not just that it runs.

## LLM provider note

Originally built assuming xAI's Grok; the actual key turned out to be Groq
(`api.groq.com`). See [[../decisions#LLM provider]] for the full story — code
is unaffected since it's provider-agnostic (`baseURL` + `apiKey` + `model`),
only `.env` values needed correcting.
