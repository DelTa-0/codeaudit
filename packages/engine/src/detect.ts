import fs from "node:fs";
import path from "node:path";
import type { Ecosystem } from "./registry.js";
import { listPythonFiles } from "./python/imports.js";

/**
 * Detects which ecosystems a repo contains. Both can be present (polyglot
 * repos run both analyzers and their findings merge).
 */
export function detectEcosystems(repoDir: string): Ecosystem[] {
  const found: Ecosystem[] = [];

  if (fs.existsSync(path.join(repoDir, "package.json"))) found.push("npm");

  let hasPython = fs.existsSync(path.join(repoDir, "pyproject.toml"));
  if (!hasPython) {
    try {
      hasPython = fs.readdirSync(repoDir).some((e) => /^requirements[\w.-]*\.txt$/i.test(e));
    } catch {
      hasPython = false;
    }
  }
  if (!hasPython) hasPython = listPythonFiles(repoDir).length > 0;
  if (hasPython) found.push("pypi");

  return found;
}
