import type { Ecosystem } from "../registry.js";

/**
 * Curated groups of libraries that solve the same problem. Declaring two
 * members of a group is not a defect — a repo mid-migration legitimately has
 * both — but it is a strong "an agent reached for a new library instead of
 * reusing the one already here" signal, which is exactly the AI-debt pattern
 * this product exists to surface.
 *
 * Kept as a committed TS module rather than a fetched list, matching
 * data/popular.ts: offline, deterministic, and it bundles into the esbuild
 * CLI with no asset-copy step.
 *
 * `prefer` is the modern default recommended when consolidating, or null when
 * the choice is genuinely situational.
 */
export interface EquivalentGroup {
  category: string;
  ecosystem: Ecosystem;
  members: string[];
  prefer: string | null;
}

export const EQUIVALENT_GROUPS: EquivalentGroup[] = [
  { category: "date", ecosystem: "npm", members: ["moment", "dayjs", "date-fns", "luxon"], prefer: "date-fns" },
  { category: "utility", ecosystem: "npm", members: ["lodash", "underscore", "ramda"], prefer: "lodash" },
  { category: "http", ecosystem: "npm", members: ["axios", "node-fetch", "got", "superagent", "request"], prefer: "axios" },
  { category: "state", ecosystem: "npm", members: ["redux", "zustand", "jotai", "mobx", "recoil"], prefer: null },
  { category: "test", ecosystem: "npm", members: ["jest", "vitest", "mocha", "ava", "jasmine"], prefer: "vitest" },
  { category: "uuid", ecosystem: "npm", members: ["uuid", "nanoid", "shortid", "cuid"], prefer: "nanoid" },
  { category: "http", ecosystem: "pypi", members: ["requests", "httpx", "aiohttp", "urllib3"], prefer: null },
  { category: "date", ecosystem: "pypi", members: ["arrow", "pendulum", "dateutil"], prefer: null },
  { category: "test", ecosystem: "pypi", members: ["pytest", "nose", "unittest2"], prefer: "pytest" },
];
