// Bundles the MCP server into a single self-contained dist/index.js — no
// node_modules dependency at install time, so `npx codeorion-mcp` works
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
  //
  // esbuild treats an aliased bare specifier as a root replacement, not a
  // prefix redirect: "@codeaudit/engine" -> ".../verify.js" does NOT also
  // redirect "@codeaudit/engine/secrets" to ".../secrets.js" — it instead
  // appends "/secrets" onto the verify.js file path and fails to resolve.
  // Each subpath actually imported needs its own explicit alias entry.
  // secrets.js and agentConfig.js are safe to alias the same way (both
  // import only node:fs/node:path[/node:crypto] — no babel, so none of the
  // risk above applies).
  alias: {
    "@codeaudit/engine": path.resolve(here, "../packages/engine/dist/verify.js"),
    "@codeaudit/engine/secrets": path.resolve(here, "../packages/engine/dist/secrets.js"),
    "@codeaudit/engine/agentConfig": path.resolve(here, "../packages/engine/dist/agentConfig.js"),
    // All four verified babel-free: agentSurface/duplicates/license pull only
    // fs/path-level modules; staged pulls verify+manifest+smol-toml (bundled).
    "@codeaudit/engine/agentSurface": path.resolve(here, "../packages/engine/dist/agentSurface.js"),
    "@codeaudit/engine/duplicates": path.resolve(here, "../packages/engine/dist/duplicates.js"),
    "@codeaudit/engine/license": path.resolve(here, "../packages/engine/dist/license.js"),
    "@codeaudit/engine/staged": path.resolve(here, "../packages/engine/dist/staged.js"),
  },
});

await chmod("dist/index.js", 0o755);

console.log("built dist/index.js");
