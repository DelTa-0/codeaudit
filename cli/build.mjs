// Bundles the CLI into a single self-contained dist/index.js — no
// node_modules dependency at install time, so `npm publish` ships a package
// that works standalone via `npx codeaudit-scan`, without needing the monorepo's
// workspace linking or any of its own dependencies resolved on the consumer's
// machine. @codeaudit/engine's "./llm" subpath (which pulls in the "openai"
// SDK) is never imported by the CLI, so it never enters this bundle either.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  // src/index.ts already starts with its own #!/usr/bin/env node — esbuild
  // detects and hoists that automatically, so no banner needed here (adding
  // one too would duplicate the shebang line and break parsing).
  //
  // format: "cjs" (not "esm") is deliberate: @babel/traverse pulls in the
  // "debug" package, which does a conditional `require("tty")` at runtime.
  // esbuild's CJS-into-ESM interop shim can't resolve that dynamically —
  // it throws "Dynamic require of tty is not supported" the moment
  // @babel/traverse loads (caught by the isolated install+run smoke test
  // below, not by typecheck or a monorepo-context run). Native CJS output
  // uses Node's real `require`, which handles this natively. The CLI is a
  // standalone leaf executable, never imported by other ESM code, so CJS
  // output has no downside here.
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: false,
  sourcemap: false,
  // Resolve the workspace package directly rather than through node_modules
  // resolution — an unrelated Yarn PnP manifest (.pnp.cjs) elsewhere on this
  // machine's ancestor directory chain otherwise gets picked up by esbuild's
  // auto-detection and blocks normal package resolution.
  alias: {
    "@codeaudit/engine": path.resolve(here, "../packages/engine/dist/index.js"),
  },
});

// esbuild doesn't preserve the executable bit; npm's `bin` mechanism needs it.
await chmod("dist/index.js", 0o755);

console.log("built dist/index.js");
