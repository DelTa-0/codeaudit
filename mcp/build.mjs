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
  alias: {
    "@codeaudit/engine": path.resolve(here, "../packages/engine/dist/index.js"),
  },
});

await chmod("dist/index.js", 0o755);

console.log("built dist/index.js");
