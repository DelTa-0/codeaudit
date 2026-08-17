// BYOK key resolution for the CLI. Resolution order (first match wins):
// 1. GROQ_API_KEY env var -> Groq (free, this project's documented default)
// 2. OPENAI_API_KEY env var -> OpenAI (paid)
// 3. --key (or CODEAUDIT_LLM_KEY) + --url (or CODEAUDIT_LLM_URL), requiring
//    --model (or CODEAUDIT_LLM_MODEL) since there's no default model for an
//    arbitrary endpoint
// 4. --key with neither a recognized env var nor --url -> hard error, so a
//    user is never billed by a provider they didn't knowingly choose
export interface LlmFlags {
  key: string | null;
  url: string | null;
  model: string | null;
}

export interface ResolvedLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Only set for Groq, whose per-model token buckets make it useful. */
  fallbackModel?: string;
  source: "groq" | "openai" | "custom";
}

export type ResolveLlmConfigResult =
  | { ok: true; config: ResolvedLlmConfig | null }
  | { ok: false; error: string };

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL = "llama-3.3-70b-versatile";
/** Second, independently-metered Groq model — see LlmConfig.fallbackModel. */
const GROQ_FALLBACK_MODEL = "openai/gpt-oss-120b";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "gpt-4o-mini";

export function resolveLlmConfig(flags: LlmFlags, env: NodeJS.ProcessEnv): ResolveLlmConfigResult {
  if (env.GROQ_API_KEY) {
    return { ok: true, config: { apiKey: env.GROQ_API_KEY, baseUrl: GROQ_BASE_URL, model: GROQ_MODEL, fallbackModel: GROQ_FALLBACK_MODEL, source: "groq" } };
  }
  if (env.OPENAI_API_KEY) {
    return { ok: true, config: { apiKey: env.OPENAI_API_KEY, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, source: "openai" } };
  }

  const key = flags.key ?? env.CODEAUDIT_LLM_KEY ?? null;
  if (!key) return { ok: true, config: null };

  const url = flags.url ?? env.CODEAUDIT_LLM_URL ?? null;

  // Infer the provider from the key prefix when no endpoint was given.
  //
  // Setting GROQ_API_KEY worked with no other flags, but the equivalent
  // `--key gsk_...` hard-errored asking for --url and --model — so the obvious
  // command failed while the awkward one worked, and on PowerShell the env-var
  // form is the awkward one (there is no `VAR=x cmd` prefix).
  //
  // This does not weaken the rule below it: a gsk_/sk- prefix identifies its
  // provider unambiguously, so nobody reaches a provider they did not choose.
  // Anything unrecognised still has to name its endpoint explicitly.
  if (!url) {
    if (key.startsWith("gsk_")) {
      return { ok: true, config: { apiKey: key, baseUrl: GROQ_BASE_URL, model: flags.model ?? env.CODEAUDIT_LLM_MODEL ?? GROQ_MODEL, fallbackModel: GROQ_FALLBACK_MODEL, source: "groq" } };
    }
    if (key.startsWith("sk-")) {
      return { ok: true, config: { apiKey: key, baseUrl: OPENAI_BASE_URL, model: flags.model ?? env.CODEAUDIT_LLM_MODEL ?? OPENAI_MODEL, source: "openai" } };
    }
    return {
      ok: false,
      error:
        "codeaudit: --key needs --url and --model unless the key is a recognised Groq (gsk_…) or OpenAI (sk-…) key.\n" +
        "  Groq:   npx codeorion scan . --key gsk_YOUR_KEY\n" +
        "  OpenAI: npx codeorion scan . --key sk-YOUR_KEY\n" +
        "  Other:  npx codeorion scan . --key YOUR_KEY --url https://host/v1 --model MODEL",
    };
  }

  const model = flags.model ?? env.CODEAUDIT_LLM_MODEL ?? null;
  if (!model) {
    return { ok: false, error: "codeaudit: --url requires --model — there is no default model for a custom endpoint" };
  }

  return { ok: true, config: { apiKey: key, baseUrl: url, model, source: "custom" } };
}
