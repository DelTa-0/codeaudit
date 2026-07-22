// Client for the hosted /api/mcp/alternatives endpoint (server/src/routes/
// mcpAlternatives.ts). Only called when CODEAUDIT_TOKEN is set — see
// index.ts's enrichWithHostedAlternatives. Never throws: a failed or slow
// hosted call must never block the local (offline) verification result.
import type { AlternativeSuggestion, Ecosystem } from "@codeaudit/engine";

export async function fetchHostedAlternatives(
  targets: { packageName: string; ecosystem: Ecosystem }[],
  token: string,
  apiUrl: string,
): Promise<Map<string, AlternativeSuggestion[]>> {
  const result = new Map<string, AlternativeSuggestion[]>();
  if (targets.length === 0) return result;
  try {
    const res = await fetch(`${apiUrl}/api/mcp/alternatives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, packages: targets }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return result;
    const data = (await res.json()) as { alternatives?: Record<string, AlternativeSuggestion[]> };
    for (const [name, alts] of Object.entries(data.alternatives ?? {})) {
      if (Array.isArray(alts) && alts.length) result.set(name, alts);
    }
  } catch {
    // best-effort — hosted enrichment never blocks the local result
  }
  return result;
}
