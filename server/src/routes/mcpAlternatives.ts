import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { queryOne } from "../db/pool.js";
import { validateBody } from "../middleware/validate.js";
import { unauthorized } from "../lib/errors.js";
import { config } from "../lib/config.js";
import { suggestAlternatives } from "@codeaudit/engine/llm";

/**
 * Public route for codematrix-mcp — authed by the same per-repo CLI token as
 * cliUploadRouter (see routes/cliScans.ts), not a JWT: the MCP server runs
 * locally with no browser session to carry a user's cookie/JWT.
 */
export const mcpAlternativesRouter = Router();

const alternativesLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a minute." },
});

const alternativesSchema = z.object({
  token: z.string().min(10).max(100),
  packages: z
    .array(
      z.object({
        packageName: z.string().max(214),
        ecosystem: z.enum(["npm", "pypi"]),
      }),
    )
    .min(1)
    .max(50),
});

mcpAlternativesRouter.post(
  "/mcp/alternatives",
  alternativesLimiter,
  validateBody(alternativesSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof alternativesSchema>;
      const repo = await queryOne<{ id: string }>("SELECT id FROM repositories WHERE cli_token = $1", [
        body.token,
      ]);
      if (!repo) throw unauthorized("Invalid CLI token");

      if (!config.llm.apiKey) {
        res.json({ alternatives: {} });
        return;
      }

      const suggestions = await suggestAlternatives(body.packages, {
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
      });
      // suggestAlternatives()'s Map is keyed by bare package name (it has no
      // ecosystem concept of its own). Re-key the response by
      // "<ecosystem>:<name>" here so a batch with the same literal name in
      // both npm and PyPI doesn't collide on the wire — mcp/src/hosted.ts
      // reads back this same composite key.
      const alternatives: Record<string, unknown> = {};
      for (const pkg of body.packages) {
        const alts = suggestions.get(pkg.packageName);
        if (alts?.length) alternatives[`${pkg.ecosystem}:${pkg.packageName}`] = alts;
      }
      res.json({ alternatives });
    } catch (err) {
      next(err);
    }
  },
);
