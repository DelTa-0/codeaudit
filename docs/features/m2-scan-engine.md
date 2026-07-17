---
type: feature
title: "M2 — Scan Engine"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
  - milestone
status: done
related:
  - "[[../index]]"
  - "[[../architecture]]"
---

# M2 — Scan Engine (manual, public repos)

## What it delivers

The core static-analysis pipeline, working end-to-end for manually-triggered
scans of public repos — no LLM or GitHub App needed yet.

## Key pieces

See [[../architecture#Scan pipeline (the core product)]] for the full 8-step
breakdown. This milestone built steps 1–4 + 7 (clone, manifest, imports,
registry verdicts, scoring) plus the BullMQ worker wiring
(`server/src/worker.ts`) and the repo-connect/scan-trigger routes
(`routes/repos.ts`, `routes/scans.ts`).

- `lib/repoUrl.ts` — SSRF guard: HTTPS-only, `github.com` host allow-list,
  rejects credentials-in-URL, validates the `owner/repo` path shape
- Frontend: `Dashboard.tsx` (connect repo form + repo list), `RepoDetail.tsx`
  (score trend chart via recharts, scan history), `ScanDetail.tsx` (live
  status stepper that polls every 2s, dependency findings table)

## Verification performed

- Connected `sindresorhus/slugify` (real public repo) via the API, triggered
  a scan, polled to completion in ~4 seconds
- Result: score 97 (A), 1 unused dependency (`xo`) correctly identified, 3
  healthy deps, 4 files analyzed
- Confirmed no orphaned temp directories left in
  `os.tmpdir()/codeaudit-scans/` after completion
- Security spot-checks: `file:///etc/passwd` → 400, internal IP URL → 400,
  non-github.com host → 400, no-auth request → 401, 6th scan within a minute
  → 429 (rate limit)
- Full browser walkthrough: register → connect repo → live stepper →
  dependency table with real npm download counts, all rendering correctly, no
  console errors
