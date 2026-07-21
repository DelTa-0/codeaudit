---
type: reference
title: "Roadmap"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: developing
related:
  - "[[index]]"
  - "[[known-issues]]"
---

# Roadmap

## Supply-chain + tech-debt expansion — CVE / typosquat / lockfile / hotspots (2026-07-21)

Competitor research (Socket.dev, Snyk, CodeScene, SonarQube) surfaced four
gaps that kept CodeAudit from being a credible "audit" rather than only a
hallucination detector. All four shipped this session, layered onto the
existing `DependencyVerdict → findings → score → PR-comment → badge` pipeline,
and — critically — kept the shared `packages/engine/` LLM-free and heavy-dep-
free so the CLI still bundles them (they're static/HTTP only).

1. **Known-vulnerability (CVE) scanning** — new `packages/engine/src/vulns.ts`
   queries the free, key-less [OSV.dev](https://osv.dev) batch API for every
   resolved package, hydrates advisory severity, and attaches CVE/GHSA ids. New
   `vulnerable` status on `DependencyVerdict`; `score.ts` penalizes per-package
   by max severity (critical −20 … low −1, `unknown` −4). Runs in **both** the
   worker and the CLI (unlike LLM review). Surfaced as a "Known vulnerabilities"
   card in `ScanDetail.tsx` and a 🛡️ row + escalated recommendation in
   `prComment.ts`. Verified live against real OSV: `lodash@4.17.4` +
   `minimist@1.2.0` → both `vulnerable` (critical) with real GHSA ids, score 60(C).
2. **Lockfile / transitive resolution** — new `packages/engine/src/lockfile.ts`
   parses `package-lock.json` (v2/v3 + v1), `yarn.lock`, `poetry.lock`, and
   pinned `requirements.txt` into a resolved tree (exact versions + which names
   are pulled in transitively). Two payoffs: OSV matching uses exact versions
   and now surfaces **transitive** CVEs (appended as `vulnerable` verdicts via
   `applyVulnerabilities`), and a declared-but-unimported package that's
   required transitively is no longer false-flagged `unused` (new optional
   `transitivelyRequired` guard threaded into `checkDependencies` /
   `checkPythonDependencies`). Best-effort: no lockfile → prior behavior.
3. **Typosquat / slopsquat similarity** — new `packages/engine/src/typosquat.ts`
   with a hand-rolled Damerau-Levenshtein (OSA) distance against curated
   popular-package lists (`data/popular.ts`, ~130 npm + ~95 PyPI, kept as a TS
   module so it compiles to dist/ and bundles into the esbuild CLI with no
   asset-copy step). A distance-1 name escalates an otherwise-healthy package to
   `suspicious` **unless** it's clearly established (≥100k downloads — keeps
   legit near-neighbors like `preact`≈`react` from firing); distance-2 only
   enriches an already-suspicious verdict. Renders "looks like `express` —
   possible slopsquat" in the dep table.
4. **Hotspot / churn intelligence** — `server/src/analysis/aiAuthorship.ts`
   reuses its existing `git log --name-only` walk to rank files by change-
   frequency × current size, tagged AI-vs-human (reusing `isAiFile`) and whether
   they already carry a finding. New "Hotspots" card in `ScanDetail.tsx`. Stays
   server-side (needs git history), best-effort/null-on-failure like the rest of
   that module.

Ground-truth suite extended 13 → 27 checks (typosquat, `coerceVersion`,
lockfile parsing + transitive-required set) — all pass, zero regression on the
original 13. Web production build + all four workspace typechecks clean; the
standalone esbuild CLI bundle verified running against a vulnerable fixture.
Env `XAI_*`→`GROQ_*` rename and Pipfile/conda/setup.py manifests still open.

## The publish-gap regression recurred mid-session — 0.2.2 and 0.2.3 (2026-07-20/21)

Immediately after shipping Phases 1–4 below, a live scan of an unrelated
project (`pulsewatch`, a React+Express+Sequelize+BullMQ monitoring app)
surfaced the identical failure mode this whole investigation was about:
Phase 2's engine fixes (npm `NEVER_FLAG_UNUSED`, workspace awareness, JS
same-file rescue) were committed to `packages/engine` but `cli/package.json`
was never re-bumped or republished after 0.2.1. `codeaudit-scan` stayed at
0.2.1 while `main` had already moved past it — the exact mistake this
session's Phase 3 guard was built to prevent, recreated within the same
session, because "fixed the code" and "shipped the fix" were still treated
as separate steps.

Two more real, previously-undiscovered false-positive classes turned up
during that pulsewatch verification, fixed the same pass:
- **Build-only CLI tools** (`typescript`, `tsx`, `esbuild`) — added to
  `registry.ts`'s `NEVER_FLAG_UNUSED`.
- **ORM peer drivers** (`pg`/`pg-hstore` behind Sequelize's
  `dialect: "postgres"`, invisible to static analysis since Sequelize
  `require`s them internally by string) — deliberately *not* blanket-
  allowlisted like the others, since `pg` is also a package people import
  directly; a genuinely-never-touched-Postgres "unused pg" finding would
  still be real. Instead added a conditional `isImplicitOrmDriver()` check
  in `registry.ts` that only exempts Sequelize's dialect-driver family
  (`pg`, `mysql2`, `mariadb`, `tedious`, `sqlite3`, `oracledb`) when
  `sequelize`/`sequelize-typescript` is itself genuinely declared or
  imported. `@splinetool/runtime` (peer runtime required internally by
  `@splinetool/react-spline`) got the same blanket-allowlist treatment as
  the build tools, since it's narrow/specific enough to be low-risk.
- **Compiled build output scanned as source**: `imports.ts`'s `SKIP_DIRS`
  only exact-matched directory names (`dist`, `build`, `out`), missing a
  differently-named build folder like `dist-server` — which caused a
  literal duplicate dead-code candidate (`getFrom` flagged once in
  `server/services/MailTransport.ts` and again in the compiled
  `dist-server/server/services/MailTransport.js`). Generalized to a
  `SKIP_DIR_PATTERN` matching `^(dist|build|out)(-|$)`.

JS ground-truth suite extended 11 → 13 checks (`typescript`/`tsx` NOT
unused, `pg` NOT unused specifically when `sequelize` is present).
`codeaudit-scan` published as `0.2.2` then `0.2.3` (two publishes because the
first didn't include the ORM-driver/build-output fixes discovered *during*
verification of 0.2.2 itself). Pulsewatch score: 46.8(D) → 71.5(C) after
0.2.2 → 89.5(B) after 0.2.3, with the 6 remaining dead-code candidates and 2
remaining "unused" findings (`@google/genai`, `ioredis`) all independently
confirmed as genuine (zero references anywhere in the codebase for each).

**Lesson, stated plainly for next time**: an engine fix is not done when the
code changes and tests pass — it is done when the published package reflects
it. Bump-and-publish is not a follow-up step to schedule later; it's the
last line of the same change.

## Making CodeAudit Actually Useful — Phases 1–4 shipped (2026-07-20)

Follow-up to the entry below: the `a2b9411` fix already existed in `main` but
had never been republished — `codeaudit-scan@0.2.0` was published
2026-07-20T14:31:27Z and `a2b9411` was committed 16 minutes later, so every
real-world run since then (including an independent review of an unrelated
FastAPI+Pydantic finance app that rediscovered the same false-positive
classes) audited stale, already-fixed code. Full investigation and phased
plan in [[known-issues#Fixed-in-`main` Python false positives never reached
npm]]. Phases 1–4 shipped this session:

1. **Published `codeaudit-scan@0.2.1`** — the existing fix is now live.
   Re-verified against the scrapper repo: score 62(C) → 93.3(A),
   `lxml`/`uvicorn`/`python-multipart`/`python-docx` no longer flagged
   unused.
2. **Closed the remaining live (not just unpublished) engine gaps**:
   - `registry.ts` gained an npm `NEVER_FLAG_UNUSED` allowlist
     (`concurrently`, `nodemon`, `cross-env`, `husky`, `tailwindcss`,
     `postcss`, `autoprefixer`, plus `eslint-plugin-*`/`eslint-config-*`/
     `@types/*` prefix matching) mirroring the Python-side allowlist.
   - `registry.ts` gained workspace-member awareness
     (`resolveWorkspaceMemberNames`, mirroring Python's
     `collectLocalModuleNames`) — a workspace-linked dependency (e.g.
     `@codeaudit/engine`) no longer 404s against the public registry and
     gets misflagged phantom. `checkDependencies` signature gained a
     leading `repoDir` param; all three call sites updated
     (`cli/src/index.ts`, `server/src/worker.ts`,
     `server/test/ground-truth.ts`).
   - `deadcode.ts`'s same-file rescue (previously Python-only, via a
     downgrade workaround in `python/imports.ts`) generalized to a
     one-line shared fix: any symbol referenced within its own file is
     alive regardless of `exported` status. Fixes the JS/TS analog of the
     bug the Python analyzer already had fixed — an exported helper called
     only within its own file is no longer misflagged dead.
   - `llm.ts`/`score.ts`: unified the two silent, opposite LLM failure
     modes. A failed batch now falls back to unfiltered static candidates
     (matching the no-API-key path) instead of silently vanishing;
     `reviewCandidatesWithLlm` returns `{ findings, reviewStatus: "full" |
     "partial" | "skipped" }`, threaded into `ScanSummary` via
     `computeSummary`'s new optional 4th param.
   - JS ground-truth suite extended 7 → 11 checks (workspace member,
     script-only devDependency, exported-same-file-only helper); Python
     suite unchanged, still 16/16. Self-scan of the codeaudit repo itself
     confirms `@codeaudit/engine` and `concurrently` no longer flagged
     (remaining `react-toolkitz`/`@fixture/internal` phantoms are the
     test fixtures under `server/test/fixture/` being swept into a
     whole-repo scan — pre-existing, documented, out of scope here).
3. **Publish can no longer silently drift from source**: `cli/package.json`
   gained a `prepublishOnly` that runs both ground-truth suites via
   `--prefix ../server` before any publish can proceed. Verified with
   `npm publish --dry-run` — both suites ran and passed, tarball built.
4. **Reverted the disabled billing gate** — see
   [[decisions#~~Plan-limit gate temporarily disabled for testing~~ —
   REVERTED (2026-07-20)]]. Real per-tier limits restored in
   `services/plans.ts`; new `server/test/plan-limits.ts`
   (`npm run test:plan-limits`, 7/7 passing) guards the free-tier boundary
   against silently regressing again.

**Not done this session** (Phases 5–8 of the same plan, need external
accounts/infra decisions, not pure code changes): real Stripe test-mode
verification, the GitHub OAuth email 403, GitHub App live verification,
a real deployment target (Dockerfiles/hosting/TLS), CI/CD, email transport
for invites, `XAI_*`→`GROQ_*` rename, monitoring/alerting.

## Python precision fixes from real-world review (2026-07-20)

The user ran the published CLI against a real FastAPI/scraper project and
had the output independently reviewed — verdict: "mostly inaccurate"
(~38 of 40 findings were false positives). The review was correct about
*what* was wrong; two of its guesses about *why* were not:

1. **`python-docx` flagged unused** — reviewer guessed "missed the lazy
   in-function import". Wrong mechanism: the parser *does* catch indented
   imports; the real bug was an alias gap — `import docx` mapped to the
   distribution `docx` (a real, ancient PyPI package) instead of
   `python-docx`. Fixed in `aliases.ts` (+ `fitz`→`pymupdf`,
   `multipart`→`python-multipart`).
2. **`lxml`/`uvicorn`/`python-multipart` flagged unused** — genuinely
   invisible to import analysis (string-arg parser backends, CLI-invoked
   servers, framework peer deps). Added a small documented
   `NEVER_FLAG_UNUSED` allowlist in `python/registry.ts`.
3. **FastAPI route handlers + Pydantic models + same-file helpers flagged
   dead** — the dominant FP class, two mechanisms:
   - decorator-wired defs (`@app.get`, `@pytest.fixture`, …) are never
     name-referenced → now skipped entirely (column-0 decorator walk-back
     in `python/imports.ts`)
   - the Python analyzer marked every non-underscore symbol "exported",
     which bypassed the shared candidate filter's same-file-reference
     rescue — `strip_html` called by `clean_listing` in the same module
     was still flagged. Now any symbol referenced within its own file is
     downgraded to non-exported so the rescue applies. (This also covers
     `__main__`-block calls and `response_model=Model` references.)

Ground-truth suite extended from 11 to 16 checks covering all three fix
classes plus a genuinely-dead lazy-importing function that must *stay*
flagged. Synthetic reproduction of the reviewer's exact scenario now
reports only the findings the reviewer confirmed real (pillow unused, one
truly-uncalled function). JS suite still 7/7.

Known remaining limitation (documented, accepted): transitive-only deps
like `w3lib` (pulled by scrapy) can still show unused; deeper dependency-
graph awareness is future work alongside the tree-sitter upgrade path.

## Python ecosystem support (2026-07-19)

The engine, worker, CLI, and dashboard now analyze **JS/TS + Python**, with
polyglot repos running both analyzers in one scan and merging findings.
User-decided approach: pragmatic hand-written line-based Python parsing (no
tree-sitter WASM — that's the documented accuracy upgrade path), manifests
via `requirements*.txt` + `pyproject.toml` (PEP 621 `[project]` +
`[tool.poetry.*]`, parsed with `smol-toml`).

- `packages/engine/src/python/`: `manifest.ts`, `imports.ts` (line-oriented
  import/def/class/reference extraction returning the same `RepoAnalysis`
  shape as the JS analyzer, so dead-code filtering + LLM review run
  unchanged), `registry.ts` (PyPI JSON API + pypistats downloads,
  best-effort), `stdlib.ts` (~300 hardcoded stdlib names), `aliases.ts`
  (cv2→opencv-python etc. + PEP 503 normalization)
- `detect.ts` — `detectEcosystems()`; worker and CLI both run
  detect-and-merge; `DependencyVerdict` gained `ecosystem: "npm" | "pypi"`
  and the worker/CLI-upload INSERTs stopped hardcoding `'npm'`
- Dashboard: ecosystem badge column appears only on polyglot scans; CLI
  prints an ecosystem tag when polyglot and `--json` carries `ecosystem`

**False positive found and fixed during live verification**: scanning
`pallets/itsdangerous` flagged `test-itsdangerous` as phantom — it's a
*local test module* (`tests/test_itsdangerous.py`) imported by a sibling
test file, and the original local-module check only looked in the repo root
and `src/`. Fixed by deriving the local-module name set from the actual
Python file tree (every `.py` basename + every package directory segment).
Re-scan: clean 100 (A), zero phantoms.

Verified: Python ground-truth suite 11/11 (phantom/unused/healthy/stdlib-
excluded/local-module-excluded/dead-code); JS suite still 7/7; live server
scan of `pallets/itsdangerous` (real PyPI metadata + pypistats downloads
rendering in the dashboard); polyglot self-scan regression byte-identical
npm results; bundled CLI (with `smol-toml` inlined) verified in an isolated
install against scaffolded Python and polyglot projects — correct verdicts,
`(npm + pypi)` labeling, exit codes.

Out of scope, documented: tree-sitter parser upgrade, Pipfile/conda/
setup.py manifests, per-ecosystem score weighting.

## CLI package renamed to `codeaudit-scan` (2026-07-18)

First real `npm publish` attempt of `codeaudit` was rejected outright by
the registry (403, not just "name taken"): *"Package name too similar to
existing package code-audit."* npm suggested a scoped fallback
(`@doughnot/codeaudit`); tried an unscoped alternative instead —
`codeaudit-scan` cleared `npm publish --dry-run` cleanly.

Also fixed the `bin` name to match the package name exactly
(`"codeaudit-scan": "dist/index.js"`, was `"codeaudit"`) — npm's own docs
note `npx <name>` reliably resolves the single bin when the names match;
rather than lean on npx's fallback-to-sole-bin behavior (inconclusive in a
local tarball-path test), matching names removes the ambiguity entirely.

**The installed command is now `codeaudit-scan`, with `scan` as its
subcommand** — i.e. `npx codeaudit-scan scan .`, not `npx codeaudit scan .`.
Updated every reference across the landing page (Hero/Cli/FinalCta copy
buttons and the scripted terminal demo), README, docs/setup.md, the
RepoDetail settings-card description, and the server-generated CLI/CI
upload usage string (`routes/cliScans.ts`) to match. Re-verified with a
fresh isolated `npm pack` → install-outside-the-monorepo → run test using
the exact new command — same correct phantom/healthy/dead-code output as
before the rename.

## CLI made npm-publish-ready (2026-07-18, not yet published)

The CLI previously only worked inside this monorepo (workspace-linked
`@codeaudit/engine`, no real npm package). Packaged it for real standalone
distribution — `npm publish` has **not** been run (one-way, world-visible
action; needs explicit go-ahead) but everything up to that point is done
and verified.

- **Split `@codeaudit/engine`'s public API**: the main `"."` export no
  longer re-exports `reviewCandidatesWithLlm`/`LlmConfig` (which pulls in
  the `openai` SDK) — that now lives at a separate `"./llm"` subpath
  (`packages/engine/package.json` `exports` map). `server/src/worker.ts`
  updated to import from `@codeaudit/engine/llm`. This means the CLI's
  import graph never reaches `openai`, keeping the bundle lean and correct
  regardless of tree-shaking behavior.
- **Bundled the CLI with esbuild** (`cli/build.mjs`) into a single
  self-contained `dist/index.js` — no `node_modules` needed at install
  time. `cli/package.json`: `private: true` removed, real publish metadata
  added (description, keywords, repository, license, `files: ["dist"]`),
  `@codeaudit/engine` moved from `dependencies` to `devDependencies` (only
  needed to build, not to run the published package).

### Two real bugs the isolated-install test caught (not typecheck, not "run it in the monorepo")

1. **A stray, unrelated Yarn PnP manifest** at `C:\Users\ASUS\.pnp.cjs`
   (last modified May 2024, nothing to do with this project) sat in the
   ancestor directory chain of `cli/`. esbuild auto-detects `.pnp.cjs`
   files during its upward directory search and — once found, anywhere,
   no matter how far up — switches its *entire* resolver to Yarn PnP mode,
   overriding otherwise-correctly-installed regular `node_modules`
   resolution. No JS-API option exists to disable this. Fixed by renaming
   the stray file aside (`.pnp.cjs.bak`, reversible, done with explicit
   user confirmation since it's outside the project).
2. **`format: "esm"` output broke at runtime** (not at build time,
   not at typecheck): `@babel/traverse` pulls in the `debug` package,
   which does a conditional `require("tty")`. esbuild's CJS-into-ESM
   interop shim can't resolve that dynamically and throws `Dynamic
   require of "tty" is not supported` the moment `@babel/traverse` loads
   — only surfaced by actually running the packed-and-installed CLI in an
   isolated directory, never by `tsc` or by running inside the monorepo
   (where the unbundled workspace version doesn't hit esbuild's shim at
   all). Fixed by building to `format: "cjs"` instead (removed
   `"type": "module"` from `cli/package.json` to match) — correct for a
   standalone leaf executable, no downside.

### Verification performed

`npm pack` → real `.tgz` → `npm install` in a directory completely
outside the monorepo (no ancestor `package.json`, no workspace context) →
scaffolded a fresh throwaway "someone else's project" (one real npm
package `left-pad`, one fabricated non-existent package, two dead
exports) → ran the installed `codeaudit` binary against it:
correctly reported `left-pad` **healthy** (verified against the live
npm registry), the fake package **phantom**, both dead exports as
candidates, exit code 1. Zero dependency on the monorepo at any point in
this test. Also confirmed both `@codeaudit/engine` and
`@codeaudit/engine/llm` resolve correctly at real Node runtime (not just
`tsc`), and the server/worker still boot and pass the ground-truth test
after the export-map change.

### Still open before a real `npm publish`

- Confirm the `codeaudit` name is genuinely available (an unauthenticated
  `npm view codeaudit` 404 is a good sign but not a guarantee — `npm
  publish --dry-run` while logged in is the real check)
- Decide on a real semver starting point (currently `0.1.0`)
- `npm publish` itself — explicit user action, not run by the agent

## App light/dark theme + UI polish (2026-07-18)

Added a light/dark theme toggle to the dashboard app (was dark-only) and did
a consistency pass across Dashboard, RepoDetail, ScanDetail, Members,
Billing, Layout, and Auth.

- `web/src/styles.css`: light theme override block keyed by
  `:root[data-theme="light"]` (same CSS var names as the existing dark
  tokens, so every `bg-*`/`text-*`/`border-*` utility already routed through
  them repaints automatically — no per-component changes needed).
  `prefers-reduced-motion` respected.
- No-FOUC init script in `web/index.html` sets `data-theme` from
  `localStorage` (or `prefers-color-scheme`) before first paint.
- `web/src/lib/theme.ts` (`useTheme()`) + `web/src/components/ThemeToggle.tsx`
  (SVG sun/moon, no emoji) — mounted in `Layout.tsx`'s header and on the
  standalone `Auth.tsx` page (which sits outside `Layout`).
- Polish: focus-visible rings + `cursor-pointer` added to `Button` and other
  interactive elements across pages that lacked them; active-route
  highlighting on the nav (`NavLink`); hover feedback on previously-plain
  clickable rows (scan history, zombie-finding expanders).

### Bugs found and fixed during verification

1. **CSS comment self-terminated mid-sentence.** The light-theme override's
   explanatory comment contained the literal substring `*/` inside prose
   (`bg-*/text-*/border-*`), which is the CSS comment *close* token — it
   closed the comment early, leaving the rest of the sentence as raw invalid
   CSS. That garbage text got fused with the next selector
   (`:root[data-theme="light"]`) into one broken prelude, which the browser's
   parser error-recovery silently dropped in its entirety — the whole light
   theme rule vanished from the parsed stylesheet with no console error.
   Diagnosed by walking the live `CSSStyleSheet`/`CSSLayerBlockRule` tree via
   `document.styleSheets` in the browser (confirmed the rule was flat-out
   missing from parsed CSSOM despite being present in the raw `<style>`
   text). **Fix:** reworded the comment to avoid a literal `*/` mid-sentence.
2. **`transition: background-color/color` on `body` didn't retrigger when
   only the referenced `var(--color-background)` changed.** After the fix
   above, the CSS custom property itself toggled instantly and correctly
   (confirmed via `getComputedStyle(root).getPropertyValue(...)`), but
   `body`'s actual rendered `background-color`/`color` stayed on the old
   value indefinitely — a known class of browser quirk where a transition's
   change-detection doesn't always fire correctly when the *specified* value
   (`var(--color-background)`) is textually unchanged even though its
   *resolved* value changed. **Fix:** dropped the transition on `body`;
   instant theme switching, no loss in practice.
3. Also hit (and ruled out as unrelated) a stale-Vite-dev-server red herring
   mid-debugging: `curl localhost:5173` and the Browser pane's `fetch` to the
   same URL returned different compiled CSS for a few minutes after editing
   — resolved itself/wasn't the real bug; a `touch` on the file was enough
   to unstick it. Worth remembering next time compiled output looks stale:
   verify with direct CSSOM/`getPropertyValue` inspection before assuming
   it's a caching problem.

Verified: toggle click (fresh tab, single click) flips both the DOM
attribute and the actual rendered background/text color in the same tick,
in both directions; theme persists across navigation and reload; Dashboard/
RepoDetail/Members/Billing all confirmed rendering correctly in light mode
via computed-style + page-text checks; dark mode unaffected (regression
checked).

## Public landing page (2026-07-17)

Imported a full 12-section marketing design from Claude Design
(`claude.ai/design`, project "Nominal design reference", file
`CodeAudit Site.dc.html`) via the `DesignSync` MCP tool's `get_file` method,
and ported it 1:1 into `web/src/pages/Landing.tsx` +
`web/src/components/landing/*` (Nav, Hero, HeroScanDemo, Problem,
HowItWorks, Features, Cli, PrExample, DashboardPreview, Trust, Pricing,
FinalCta, Footer). Deliberately scoped-separate cream/Geist brand (`#f7f6f1`
bg, `#101512` text) from the dashboard's dark theme — inline styles, no
changes to `styles.css`.

Routing restructured: `/` is now the public landing page; the app moved from
`/` to `/dashboard`. Authenticated users hitting `/` auto-redirect to
`/dashboard` (checked in `Landing.tsx` via `useAuth()`). Updated
`Auth.tsx`'s post-login/register redirect targets and `Layout.tsx`'s nav
links accordingly.

Ported the design's `DCLogic` animation class to a `useScanDemo()` +
`useCopyCommand()` hook pair (`web/src/lib/useScanDemo.ts`): rotating hero
word (2.4s), animated terminal log reveal (650ms/line) with a looping
score count-up to 82, and clipboard-copy feedback for the three
`npx codeaudit scan .` CTAs. Verified via direct in-page JS polling (avoided
relying on tool-roundtrip screenshots, which have enough latency to miss the
1.5s copy-feedback window or land mid-animation-cycle and look "frozen"
when it isn't — worth remembering for future animation verification).

- [x] All 12 sections render, no console errors
- [x] Copy-to-clipboard verified end-to-end (icon → "✓ copied" → reverts)
- [x] Logged-out `/` shows landing; logged-in `/` redirects to `/dashboard`; `/dashboard` still renders the existing repo list correctly, dark theme unaffected
- [x] No horizontal overflow at 375px mobile width
- [ ] Not yet done: swap the placeholder footer links (Docs, GitHub App, Security, Privacy, Contact) for real pages/anchors when those exist

## Feature pack (post-M5, all built 2026-07-17)

Research-driven additions (SonarQube gates / Codecov badges / Renovate
auto-PRs / 2026 AI-debt reports). Everything is opt-in per repo, default off,
audit-logged — the system only reports or proposes, never acts unilaterally.

- [x] **`packages/engine/`** — analysis modules extracted to a shared workspace (`@codeaudit/engine`), used by server and CLI; ground-truth test still 7/7
- [x] **CLI `npx codeaudit scan`** — limited funnel edition: static-only (no LLM/history/PR), `--json`, `--min-score`, exit 1 on phantom deps, SaaS footer. Verified against the fixture
- [x] **README badge** — `GET /api/badge/:token.svg`, unguessable token, 5-min cache; "Get badge" in the repo settings card. Verified (97 A green SVG)
- [x] **Merge gate** — GitHub check run (success/failure vs `min_score`, neutral on scan failure) posted only when `gate_enabled`; blocking is the owner's branch-protection choice. Toggle verified; live check needs **Checks: read & write** on the App
- [x] **Auto-fix PRs** — double opt-in (repo toggle + explicit button); removes ≤10 unused deps on a `codeaudit/*` branch and opens a PR with requester attribution. Consent gates verified (403/400 paths); live PR needs **Contents: read & write** on the App
- [x] **AI-authorship metrics** — clone deepened to 100 commits; Co-Authored-By/bot heuristic; `summary.ai` + dashboard card. Verified live: 95% AI-touched on this very repo

## The 5-milestone plan (all code-complete)

Originally scoped as `M1–M5` in the approved implementation plan. All five
were built and verified in a single session; see `features/` for what each
one actually contains.

- [x] [[features/m1-foundation]] — monorepo, docker-compose, migrations, auth, orgs/roles, React shell
- [x] [[features/m2-scan-engine]] — BullMQ, sandboxed clone, AST analysis, npm registry verdicts, live dashboard
- [x] [[features/m3-llm-zombie-layer]] — dead-code candidates, LLM batch review, weighted health score
- [x] [[features/m4-github-app]] — OAuth, App install, webhooks, PR sticky comments
- [x] [[features/m5-billing]] — Stripe checkout/portal/webhooks, plan limits

## Immediate next steps (picking back up)

0. **Publish `codeaudit-scan@0.2.1`** — see [[known-issues#Fixed-in-`main`
   Python false positives never reached npm]]. The real-world-review fix
   (`a2b9411`) has sat committed-but-unpublished since 2026-07-20; every
   `npx codeaudit-scan scan` run since then (including a second independent
   FastAPI+Pydantic review that rediscovered the same false-positive
   classes) has been auditing stale registry code. This is higher priority
   than any further engine work — there is no point fixing more false
   positives if the fixes never ship. Concretely:
   - [ ] Bump `cli/package.json` version (`0.2.0` → `0.2.1`)
   - [ ] `npm publish` (explicit user go-ahead required)
   - [ ] Re-run `npx codeaudit-scan@latest scan` against the scrapper repo
     and confirm `lxml`/`uvicorn`/`python-multipart`/`python-docx` no
     longer show as unused and the FastAPI-shaped dead-code candidates are
     gone
   - [ ] Add a lightweight release-drift guard so this can't silently
     recur — e.g. a `postversion`/CI check that fails if `packages/engine`
     has commits after the currently-published dist-tag's publish
     timestamp, or simply fold "bump + publish" into the same commit as
     any engine fix from now on instead of treating them as separable steps
   - [ ] Audit whether the JS/TS analyzer (`imports.ts`/`deadcode.ts`) has
     the equivalent gap: it has no same-file-exported-symbol rescue
     (`python/imports.ts:188-192`'s downgrade logic was never mirrored for
     JS) — an exported helper called only within its own file would still
     be misflagged. Either port the same downgrade into the JS analyzer or,
     better, move the rescue into the shared `deadcode.ts` filter so both
     languages get it from one fix instead of two.
1. **Finish debugging GitHub OAuth email 403** — see [[known-issues#GitHub OAuth email permission]]
2. ~~Set up the ngrok tunnel and register the real webhook URL~~ — **DONE**: real push → webhook → scan confirmed working end-to-end. ~~Confirm pull_request → sticky PR comment~~ — **DONE**: opened a real PR (`DelTa-0/codeaudit#1`), webhook fired, scan ran with `pr_number` set, comment posted (`[pr-comment] posted on DelTa-0/codeaudit#1`). One gotcha hit along the way — see [[known-issues#Repo connected via URL paste has no linked installation → PR comment silently no-ops]]
3. **Connect a real Stripe test-mode account** — set `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/price IDs, run an actual test-mode checkout to confirm the full redirect + webhook flow (not just a signed fake payload). Currently moot for testing — plan limits are temporarily disabled, see [[decisions#Plan-limit gate temporarily disabled for testing]]
4. **Install the GitHub App on a real private repo** and confirm private-repo cloning via installation token works end-to-end

## Explicit post-M5 backlog (from the original plan, never started)

- **Python/PyPI ecosystem support** — currently JS/TS + npm only. Would need
  a Python AST parser (candidate: `ast` via a small Python sidecar, or a
  JS-native Python parser) and PyPI registry checks mirroring `registry.ts`
- **SSE for live scan status** — currently the frontend polls
  `GET /api/scans/:id` every ~2s; server-sent events would remove the polling
  delay and reduce request volume
- **Slack notifications** — mentioned in the original spec's enterprise
  feature list, never implemented
- **Real email transport for invites** — see [[known-issues#No email transport for invites]]
- **Rename `XAI_*` env vars to `GROQ_*`** — cosmetic, see [[known-issues#`XAI_*` env var naming is misleading]]

## Things intentionally left as follow-ups, not gaps

- No CI/CD — not requested, not blocking local dev/demo
- No test suite beyond the ground-truth fixture test
  (`server/test/ground-truth.ts`) — sufficient for validating the analysis
  engine's correctness, but no route-level integration tests exist yet
- Local dev only — no deployment target chosen yet (Nitro/Cloudflare was
  used for the *landing page* project, `ai-debt-cleaner`, not this one)
