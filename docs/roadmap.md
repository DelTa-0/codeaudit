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
