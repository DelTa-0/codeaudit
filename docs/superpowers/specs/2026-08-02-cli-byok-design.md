---
type: reference
title: "CLI Bring-Your-Own-Key (BYOK) LLM review — design"
created: 2026-08-02
status: implemented
related:
  - "[[architecture]]"
  - "[[decisions]]"
  - "[[known-issues]]"
---

# CLI Bring-Your-Own-Key (BYOK) LLM review

## Problem

The CLI (`codeaudit-scan`) is deliberately static-only — no LLM review, no scan
history, no PR integration — by design, per the existing `README.md`/
`cli/README.md` "funnel" positioning: it's meant to drive adoption of the
hosted product, not replace it.

That's the right shape for the free tier. But it means a CLI user gets
materially worse dead-code accuracy than a hosted scan even when they'd be
willing to pay for LLM review themselves — dead-code candidates are always
flat 0.5-confidence static guesses, and phantom-package "did you mean X?"
suggestions never fire beyond fuzzy spelling matches. There's currently no way
to narrow that gap without going through the hosted product at all.

## Goal

Let a CLI user supply their own LLM API key so `codeaudit-scan` can perform
real LLM-backed dead-code review and phantom-package alternative suggestions
locally — the same two capabilities `reviewCandidatesWithLlm`/
`suggestAlternatives` already provide server-side, now reachable from the CLI.
This is additive to the CLI's existing static-only behavior, not a
replacement: with no key supplied, behavior is unchanged.

Explicitly out of scope: BYOK for the hosted dashboard/worker (org-level key
storage, encryption at rest, billing implications) — a different project with
a different trust model, since it would be the first user-supplied secret this
codebase ever stores in its own database. This design covers the CLI only,
where the key lives in the user's own process and is never persisted anywhere
CodeAudit controls.

## Architecture

### Remove the `openai` SDK; replace with a fetch wrapper

`packages/engine/src/llm.ts` currently depends on the `openai` npm package
(8.7MB) for exactly one operation at each of its two call sites:
`client.chat.completions.create({...})`, reading back
`completion.choices[0].message.content`. No streaming, no function-calling,
nothing the SDK's abstraction earns its weight for here.

This split existed specifically so the CLI's import graph would never reach
`openai`, keeping the standalone esbuild bundle lean (see `decisions.md`,
"CLI made npm-publish-ready"). BYOK needs the CLI to call an LLM, which
directly conflicts with that boundary. Rather than accept either a heavier CLI
bundle (bundling `openai` in) or a maintenance fork (reimplementing the same
prompt/parsing logic separately in `cli/`), replace the SDK with a ~40-line
`fetch()`-based wrapper that both server and CLI share:

```ts
// packages/engine/src/llm.ts
async function callChatCompletion(
  config: LlmConfig,
  messages: { role: "system" | "user"; content: string }[],
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0, max_tokens: 2000 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    // Preserve the shape reviewFileBatch's existing retry logic already reads
    // off caught errors (err.status, err.headers["retry-after"]) — that logic
    // was written against openai SDK error objects and must not need to
    // change when the SDK is removed.
    const err = new Error(`LLM request failed: ${res.status}`) as Error & {
      status: number;
      headers: Record<string, string>;
    };
    err.status = res.status;
    err.headers = Object.fromEntries(res.headers.entries());
    throw err;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}
```

Both `reviewFileBatch` and the phantom-alternative suggester call this instead
of constructing an `OpenAI` client. `openai` is removed from
`packages/engine/package.json` and the root lockfile. The `"./llm"` export
subpath split in `packages/engine/package.json` (kept separate from `"."`
specifically to keep `openai` out of the CLI bundle) is removed — `llm.ts`'s
exports fold back into the main `"."` export, since the reason for the split
no longer exists. `server/src/worker.ts` updates its import path accordingly;
no behavioral change there.

### CLI wiring

`cli/src/index.ts` builds an `LlmConfig` when a key is resolved (see
"Key resolution" below) and passes it through exactly the same conditional the
worker already uses: `apiKey ? { apiKey, baseUrl, model } : undefined`. No new
code path — the CLI is reaching a branch that already exists and is already
tested server-side.

## Key resolution

No flags are required for the common case. Resolution order:

1. `GROQ_API_KEY` env var, if set → provider is Groq
   (`https://api.groq.com/openai/v1`, model `llama-3.3-70b-versatile`) — free,
   matching this project's own documented preference (`decisions.md`, "LLM
   provider").
2. `OPENAI_API_KEY` env var, if set → provider is OpenAI
   (`https://api.openai.com/v1`, model `gpt-4o-mini`) — paid; the CLI notes
   this in its output when LLM review runs.
3. `--key T` flag (or `CODEAUDIT_LLM_KEY` env var) together with `--url URL`
   (or `CODEAUDIT_LLM_URL`) — any OpenAI-compatible `chat/completions`
   endpoint. `--url` is not optional in this case (see rule 4). `--model M`
   (or `CODEAUDIT_LLM_MODEL`) is **required** alongside a custom `--url` —
   there is no sensible universal default for an arbitrary endpoint, unlike
   rules 1–2 where the env var name itself identifies a known provider with a
   known default model.
4. `--key` supplied with neither a recognized env var (rules 1–2) nor `--url`
   → **hard error**, does not silently assume a provider:
   `codeaudit: --key requires --url (or set GROQ_API_KEY / OPENAI_API_KEY
   instead)`, exit code 2. Likewise, `--key` + `--url` with no `--model` →
   `codeaudit: --url requires --model — there is no default model for a
   custom endpoint`, exit code 2.

Flag wins over env var when both are present, matching the existing
`--token`/`CODEAUDIT_TOKEN` precedence. Rule 4 exists so a user can never be
billed by a provider they didn't knowingly choose — env var *names* already
disambiguate the provider in cases 1–2, so only the bare-flag case (3) needs
an explicit `--url`.

## Scope: what BYOK unlocks

Both LLM-backed capabilities the engine already has, reached from the CLI for
the first time:

- **Dead-code review** (`reviewCandidatesWithLlm`) — candidates get real
  confidence scores and reasoning instead of the flat 0.5 static placeholder.
  `reviewStatus` becomes `"full"`/`"partial"` instead of always `"skipped"`.
- **Phantom-package alternatives** (`suggestAlternatives`) — an AI-suggested
  real replacement for a phantom package name with no fuzzy spelling match
  (e.g. `fastimagepro` → Pillow/imageio), currently hosted-only via
  `codeaudit-mcp`'s `CODEAUDIT_TOKEN` path.

## Upload provenance

`cli/src/index.ts`'s `--upload` payload gains two fields, sent only when
review actually happened:

- `reviewStatus`: the CLI's own already-computed `"full"`/`"partial"`/
  `"skipped"`, not re-derived server-side
- `llmReviewSource: "cli-byok"` — present only when `reviewStatus !== "skipped"`

`server/src/routes/cliScans.ts`'s `uploadSchema` gains both as **optional**
fields — an older published CLI that doesn't send them keeps working exactly
as today, defaulting to `"skipped"`. The stored `summary` JSONB carries
`llmReviewSource` through unchanged, following the same "ride the existing
JSONB column, no migration" pattern already established for prior features
(`decisions.md`, "OSV.dev for CVE scanning").

`web/src/pages/ScanDetail.tsx`'s existing warning banner branches on
`reviewStatus`; its current `"skipped"` copy — *"expected for CLI uploads, or
when the server has no model API key set"* — becomes inaccurate once this
ships and must be rewritten regardless of BYOK, since CLI uploads are no
longer inherently unreviewed. When `llmReviewSource === "cli-byok"`, the
banner is replaced with something stating the review was self-reported and
not platform-verified — the dashboard has no way to confirm the CLI's claim is
honest, and must never imply platform-verified confidence for it.

**Hard constraint**: the LLM key itself is never included in the `--upload`
body, never logged, never written to disk, never present in `--json` output —
used only in the `Authorization` header of requests to the URL the user
configured. Same non-negotiable discipline this session already applied to
secret-finding values (`packages/engine/src/secrets.ts`'s `redact()`
boundary).

## Error handling

A failed or misconfigured BYOK call must never crash the scan or change the
CLI's documented exit-code contract (0/1/2). It degrades to exactly the
existing no-key behavior: unfiltered static candidates, `reviewStatus:
"partial"`, a reasoning string explaining why (rate limit, timeout, non-2xx
response). This is the same fallback path `reviewFileBatch` already has for
the hosted worker — BYOK reaches it, it doesn't duplicate it.

## Testing

- A protocol-shape test for `callChatCompletion` against a local mock HTTP
  server (no live API call — this tests wire format, not model quality):
  success parses `choices[0].message.content`; a 429 response produces a
  caught error with `status === 429`; a 500 does the same; the constructed
  error's `headers` reflects the response's headers so `retry-after` handling
  keeps working.
- Flag/env resolution: `--key` overrides env; `GROQ_API_KEY` is chosen over
  `OPENAI_API_KEY` when both are set; bare `--key` with no `--url` and no
  recognized env var exits 2 with the documented message; `--key` + `--url`
  with no `--model` exits 2 with the documented message.
- A redaction-style assertion matching this session's established convention:
  construct a fake key with a distinctive value, run a scan (mocked LLM
  endpoint) with `--json` and separately with `--upload`, and assert the key
  value is absent from both serialized outputs.
- Full existing ground-truth suites (JS, Python, plan-limits) must stay green
  — this change touches `llm.ts`, which the hosted worker also depends on, so
  a regression here would be silent for CLI users and loud for hosted ones.

## Deliberately not in scope

- Hosted dashboard BYOK (org-level key storage/encryption) — different trust
  model, separate design.
- Non-OpenAI-compatible providers (native Anthropic API, etc.) — would need
  real provider-specific request/response translation; `--url` already covers
  every OpenAI-compatible provider (OpenAI, Groq, local Ollama, Anthropic via
  an OpenAI-compatible proxy) with zero additional code.
- Retrying with a different provider on failure — a BYOK failure degrades to
  static-only, it doesn't fail over to a second configured provider.
