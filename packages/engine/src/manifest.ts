import fs from "node:fs";
import path from "node:path";

export interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/** Reads the root package.json as plain text — never installs or executes anything. */
export function parseManifest(repoDir: string): Manifest | null {
  const file = path.join(repoDir, "package.json");
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      dependencies: parsed.dependencies ?? {},
      devDependencies: parsed.devDependencies ?? {},
    };
  } catch {
    return null;
  }
}
