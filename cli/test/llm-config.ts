// Flag/env precedence checks for the CLI's BYOK key resolution. Pure-function
// tests — no network, no process spawning.
// Run: npm run test:llm-config
import { resolveLlmConfig } from "../src/llmConfig.js";

const checks: [string, boolean][] = [];

{
  const r = resolveLlmConfig({ key: null, url: null, model: null }, {});
  checks.push(["no key anywhere resolves to ok with null config (static-only, unchanged)", r.ok === true && r.config === null]);
}

{
  const r = resolveLlmConfig({ key: null, url: null, model: null }, { GROQ_API_KEY: "groq-secret" });
  checks.push([
    "GROQ_API_KEY alone resolves to the groq provider",
    r.ok === true && r.config?.source === "groq" && r.config.apiKey === "groq-secret" && r.config.model === "llama-3.3-70b-versatile",
  ]);
}

{
  const r = resolveLlmConfig(
    { key: null, url: null, model: null },
    { GROQ_API_KEY: "groq-secret", OPENAI_API_KEY: "openai-secret" },
  );
  checks.push(["GROQ_API_KEY is chosen over OPENAI_API_KEY when both are set", r.ok === true && r.config?.source === "groq"]);
}

{
  const r = resolveLlmConfig({ key: null, url: null, model: null }, { OPENAI_API_KEY: "openai-secret" });
  checks.push([
    "OPENAI_API_KEY alone resolves to the openai provider",
    r.ok === true && r.config?.source === "openai" && r.config.apiKey === "openai-secret" && r.config.model === "gpt-4o-mini",
  ]);
}

{
  const r = resolveLlmConfig(
    { key: "flag-key", url: "https://example.com/v1", model: "flag-model" },
    { CODEAUDIT_LLM_KEY: "env-key", CODEAUDIT_LLM_URL: "https://env.example.com/v1", CODEAUDIT_LLM_MODEL: "env-model" },
  );
  checks.push([
    "--key/--url/--model override their corresponding CODEAUDIT_LLM_* env vars",
    r.ok === true &&
      r.config?.apiKey === "flag-key" &&
      r.config.baseUrl === "https://example.com/v1" &&
      r.config.model === "flag-model" &&
      r.config.source === "custom",
  ]);
}

{
  const r = resolveLlmConfig(
    { key: null, url: null, model: null },
    { CODEAUDIT_LLM_KEY: "env-key", CODEAUDIT_LLM_URL: "https://env.example.com/v1", CODEAUDIT_LLM_MODEL: "env-model" },
  );
  checks.push([
    "CODEAUDIT_LLM_KEY/_URL/_MODEL env vars alone resolve a custom provider",
    r.ok === true && r.config?.source === "custom" && r.config.apiKey === "env-key",
  ]);
}

{
  const r = resolveLlmConfig({ key: "flag-key", url: null, model: null }, {});
  checks.push([
    "an unrecognised bare --key still refuses to guess an endpoint",
    r.ok === false && r.error.includes("--key needs --url and --model"),
  ]);
  checks.push([
    "…and the error shows a copyable example for each provider",
    r.ok === false && r.error.includes("--key gsk_YOUR_KEY") && r.error.includes("--key sk-YOUR_KEY"),
  ]);
}

// A gsk_/sk- prefix names its provider unambiguously, so `--key` alone should
// work exactly as the matching env var already did. Previously the flag form
// hard-errored while the env form succeeded, which is the asymmetry that made
// BYOK confusing — especially on PowerShell, where `VAR=x cmd` is not valid.
{
  const r = resolveLlmConfig({ key: "gsk_abc123", url: null, model: null }, {});
  checks.push([
    "--key gsk_… alone resolves to Groq with its default model",
    r.ok === true &&
      r.config?.source === "groq" &&
      r.config.baseUrl === "https://api.groq.com/openai/v1" &&
      r.config.model === "llama-3.3-70b-versatile",
  ]);
}

{
  const r = resolveLlmConfig({ key: "sk-abc123", url: null, model: null }, {});
  checks.push([
    "--key sk-… alone resolves to OpenAI with its default model",
    r.ok === true && r.config?.source === "openai" && r.config.baseUrl === "https://api.openai.com/v1",
  ]);
}

{
  const r = resolveLlmConfig({ key: "gsk_abc123", url: null, model: "llama-3.1-8b-instant" }, {});
  checks.push([
    "--model still overrides the inferred provider's default",
    r.ok === true && r.config?.source === "groq" && r.config.model === "llama-3.1-8b-instant",
  ]);
}

{
  const r = resolveLlmConfig(
    { key: "gsk_abc123", url: "https://proxy.internal/v1", model: "custom-model" },
    {},
  );
  checks.push([
    "an explicit --url still wins over prefix inference",
    r.ok === true && r.config?.source === "custom" && r.config.baseUrl === "https://proxy.internal/v1",
  ]);
}

{
  const r = resolveLlmConfig({ key: "flag-key", url: "https://example.com/v1", model: null }, {});
  checks.push([
    "--key + --url with no --model exits with the documented message",
    r.ok === false && r.error === "codeaudit: --url requires --model — there is no default model for a custom endpoint",
  ]);
}

console.log("--- LLM key-resolution checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exitCode = failed ? 1 : 0;
