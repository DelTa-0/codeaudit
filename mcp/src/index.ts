#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { verifyPackage, type PackageVerifyResult } from "@codeaudit/engine";
import { fetchHostedAlternatives } from "./hosted.js";

const token = process.env.CODEAUDIT_TOKEN || null;
const apiUrl = process.env.CODEAUDIT_API_URL || "https://api.codeaudit.dev";
const CONCURRENCY = 5;

/**
 * Runs `fn` over `items` with at most `limit` in flight at once — same
 * queue/workerLoop shape registry.ts uses for its own registry lookups,
 * so a large verify_packages batch doesn't hammer npm/PyPI all at once.
 */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  async function worker() {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      results[next.i] = await fn(next.item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * When the agent doesn't specify an ecosystem, try npm first (the larger of
 * the two popular-package lists, and most ambiguous bare names in practice
 * are JS packages), then PyPI. If neither registry has the name, report the
 * npm result — the fuzzy "did you mean" match still runs against npm's
 * (larger) popular-package list.
 */
async function verifyWithGuessedEcosystem(
  name: string,
  ecosystem?: "npm" | "pypi",
): Promise<PackageVerifyResult> {
  if (ecosystem) return verifyPackage(name, ecosystem);
  const npmResult = await verifyPackage(name, "npm");
  if (npmResult.exists) return npmResult;
  const pypiResult = await verifyPackage(name, "pypi");
  if (pypiResult.exists) return pypiResult;
  return npmResult;
}

/** Mutates phantom-with-no-fuzzy-match results in place with a hosted LLM suggestion, only when CODEAUDIT_TOKEN is set. */
async function enrichWithHostedAlternatives(results: PackageVerifyResult[]): Promise<void> {
  if (!token) return;
  const needing = results.filter((r) => r.status === "phantom" && !r.alternatives?.length);
  if (needing.length === 0) return;
  const hosted = await fetchHostedAlternatives(
    needing.map((r) => ({ packageName: r.name, ecosystem: r.ecosystem })),
    token,
    apiUrl,
  );
  for (const r of needing) {
    const alts = hosted.get(r.name);
    if (alts?.length) r.alternatives = alts;
  }
}

const TOOL_DESCRIPTION_PREFIX =
  "Call this before running an install command for any package the user did not explicitly name, and before adding a new entry to a manifest file. ";

const server = new McpServer({ name: "codeaudit-mcp", version: "0.1.0" });

server.registerTool(
  "verify_package",
  {
    title: "Verify package",
    description:
      TOOL_DESCRIPTION_PREFIX +
      "Checks whether the package actually exists on its registry (npm or PyPI), whether it looks like a typo of a popular package, its download count and age, and any known CVEs. Returns a suggested real alternative when the package doesn't exist.",
    inputSchema: {
      name: z.string().min(1).max(214).describe("The package name to verify."),
      ecosystem: z
        .enum(["npm", "pypi"])
        .optional()
        .describe("The registry to check. Omit to auto-detect (tries npm, then PyPI)."),
    },
  },
  async ({ name, ecosystem }) => {
    const result = await verifyWithGuessedEcosystem(name, ecosystem);
    await enrichWithHostedAlternatives([result]);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "verify_packages",
  {
    title: "Verify multiple packages",
    description:
      TOOL_DESCRIPTION_PREFIX +
      "Same checks as verify_package, batched for reviewing an entire new dependency list at once (e.g. every new entry in a package.json or requirements.txt diff) instead of one call per package.",
    inputSchema: {
      packages: z
        .array(
          z.object({
            name: z.string().min(1).max(214),
            ecosystem: z.enum(["npm", "pypi"]).optional(),
          }),
        )
        .min(1)
        .max(50)
        .describe("The packages to verify."),
    },
  },
  async ({ packages }) => {
    const results = await mapConcurrent(packages, CONCURRENCY, (p) =>
      verifyWithGuessedEcosystem(p.name, p.ecosystem),
    );
    await enrichWithHostedAlternatives(results);
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
