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
  source: "groq" | "openai" | "custom";
}

export type ResolveLlmConfigResult =
  | { ok: true; config: ResolvedLlmConfig | null }
  | { ok: false; error: string };

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "gpt-4o-mini";

export function resolveLlmConfig(flags: LlmFlags, env: NodeJS.ProcessEnv): ResolveLlmConfigResult {
  if (env.GROQ_API_KEY) {
    return { ok: true, config: { apiKey: env.GROQ_API_KEY, baseUrl: GROQ_BASE_URL, model: GROQ_MODEL, source: "groq" } };
  }
  if (env.OPENAI_API_KEY) {
    return { ok: true, config: { apiKey: env.OPENAI_API_KEY, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, source: "openai" } };
  }

  const key = flags.key ?? env.CODEAUDIT_LLM_KEY ?? null;
  if (!key) return { ok: true, config: null };

  const url = flags.url ?? env.CODEAUDIT_LLM_URL ?? null;
  if (!url) {
    return { ok: false, error: "codeaudit: --key requires --url (or set GROQ_API_KEY / OPENAI_API_KEY instead)" };
  }

  const model = flags.model ?? env.CODEAUDIT_LLM_MODEL ?? null;
  if (!model) {
    return { ok: false, error: "codeaudit: --url requires --model — there is no default model for a custom endpoint" };
  }

  return { ok: true, config: { apiKey: key, baseUrl: url, model, source: "custom" } };
}
