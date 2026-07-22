// Bundles the MCP server into a single self-contained dist/index.js — no
// node_modules dependency at install time, so `npx codeaudit-mcp` works
// standalone. Mirrors cli/build.mjs. ESM output (unlike the CLI's CJS
// output) is safe here because this package never imports @babel/traverse
// (no import-graph analysis happens in the MCP server), which is what
// forced the CLI onto CJS.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  minify: false,
  sourcemap: false,
  // Alias straight to verify.js (not the package's barrel index.js) so this
  // bundle only pulls in the small dependency-checking modules it actually
  // uses. The barrel also re-exports analyzeRepo/findDeadCodeCandidates,
  // which transitively import @babel/parser + @babel/traverse (CJS
  // packages) — esbuild's ESM output can't safely tree-shake those out
  // (CJS requires are treated as having side effects), and bundling them
  // in breaks at runtime ("Dynamic require of \"tty\" is not supported",
  // from @babel/traverse's "debug" dependency). The MCP server never does
  // import-graph analysis, so it never needs that code path.
  alias: {
    "@codeaudit/engine": path.resolve(here, "../packages/engine/dist/verify.js"),
  },
});

await chmod("dist/index.js", 0o755);

console.log("built dist/index.js");
