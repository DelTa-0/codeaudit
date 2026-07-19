import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { normalizePyPiName } from "./aliases.js";

export interface PythonManifest {
  /** PEP 503-normalized name -> raw version spec (may be "") */
  dependencies: Record<string, string>;
}

/**
 * Splits a requirements-style dependency line ("name[extras]>=1.2, <2 ; markers")
 * into a normalized name + spec. Returns null for lines that aren't plain
 * package requirements (URLs, -e editable installs, options).
 */
function parseRequirementLine(rawLine: string): { name: string; spec: string } | null {
  const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
  if (!line) return null;
  if (line.startsWith("-") || line.startsWith("--")) return null; // options, -e, -r handled separately
  if (/^(https?|git\+|file:)/.test(line)) return null;
  const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
  if (!match) return null;
  const spec = match[3].split(";")[0].trim();
  return { name: normalizePyPiName(match[1]), spec };
}

function readRequirementsFile(filePath: string, deps: Record<string, string>, depth: number) {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    // Follow one level of -r includes relative to the current file.
    const include = trimmed.match(/^(?:-r|--requirement[= ])\s*(.+)$/);
    if (include && depth < 1) {
      readRequirementsFile(path.resolve(path.dirname(filePath), include[1].trim()), deps, depth + 1);
      continue;
    }
    const parsed = parseRequirementLine(rawLine);
    if (parsed && !(parsed.name in deps)) deps[parsed.name] = parsed.spec;
  }
}

function collectFromPyproject(filePath: string, deps: Record<string, string>) {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const project = doc.project as { dependencies?: unknown; "optional-dependencies"?: unknown } | undefined;
  const pep508Lists: unknown[] = [];
  if (Array.isArray(project?.dependencies)) pep508Lists.push(...project.dependencies);
  const optional = project?.["optional-dependencies"];
  if (optional && typeof optional === "object") {
    for (const group of Object.values(optional)) {
      if (Array.isArray(group)) pep508Lists.push(...group);
    }
  }
  for (const entry of pep508Lists) {
    if (typeof entry !== "string") continue;
    const parsed = parseRequirementLine(entry);
    if (parsed && !(parsed.name in deps)) deps[parsed.name] = parsed.spec;
  }

  // Poetry: [tool.poetry.dependencies] name = "spec" | { version = "spec", ... }
  const tool = doc.tool as { poetry?: { dependencies?: Record<string, unknown>; "dev-dependencies"?: Record<string, unknown>; group?: Record<string, { dependencies?: Record<string, unknown> }> } } | undefined;
  const poetrySections: Record<string, unknown>[] = [];
  if (tool?.poetry?.dependencies) poetrySections.push(tool.poetry.dependencies);
  if (tool?.poetry?.["dev-dependencies"]) poetrySections.push(tool.poetry["dev-dependencies"]);
  if (tool?.poetry?.group) {
    for (const group of Object.values(tool.poetry.group)) {
      if (group?.dependencies) poetrySections.push(group.dependencies);
    }
  }
  for (const section of poetrySections) {
    for (const [name, value] of Object.entries(section)) {
      if (name.toLowerCase() === "python") continue; // interpreter constraint, not a package
      const normalized = normalizePyPiName(name);
      if (normalized in deps) continue;
      const spec =
        typeof value === "string"
          ? value
          : value && typeof value === "object" && "version" in value
            ? String((value as { version: unknown }).version)
            : "";
      deps[normalized] = spec;
    }
  }
}

/** Reads requirements*.txt and pyproject.toml. Returns null when neither exists. */
export function parsePythonManifest(repoDir: string): PythonManifest | null {
  const deps: Record<string, string> = {};
  let found = false;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(repoDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (/^requirements[\w.-]*\.txt$/i.test(entry)) {
      found = true;
      readRequirementsFile(path.join(repoDir, entry), deps, 0);
    }
  }
  const requirementsDir = path.join(repoDir, "requirements");
  if (fs.existsSync(requirementsDir) && fs.statSync(requirementsDir).isDirectory()) {
    for (const entry of fs.readdirSync(requirementsDir)) {
      if (entry.endsWith(".txt")) {
        found = true;
        readRequirementsFile(path.join(requirementsDir, entry), deps, 0);
      }
    }
  }

  const pyproject = path.join(repoDir, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    const before = Object.keys(deps).length;
    collectFromPyproject(pyproject, deps);
    // pyproject.toml alone counts as a Python manifest even if it declared
    // nothing (e.g. build-system only) — .py detection covers the rest.
    if (Object.keys(deps).length > before || fs.readFileSync(pyproject, "utf8").includes("[project]") || fs.readFileSync(pyproject, "utf8").includes("[tool.poetry]")) {
      found = true;
    }
  }

  return found ? { dependencies: deps } : null;
}
