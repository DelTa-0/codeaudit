import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { validateBody } from "../middleware/validate.js";
import { recordPhantomReport } from "../services/phantomReports.js";

/**
 * The corpus flywheel's intake: opted-in codeorion-mcp installs POST here
 * when verify_package returns "phantom".
 *
 * Unauthenticated by design — requiring an account would gut the sensor
 * network this exists to build, and the endpoint accepts nothing worth
 * stealing: a package name and an ecosystem, both already public concepts.
 * The abuse case is flooding, not theft, so the defences are shaped for
 * that: tight rate limit, tight schema, and an upsert that collapses any
 * volume of repeats into one row — plus the human review gate downstream,
 * which is what actually keeps a poisoner out of the shipped corpus.
 */
export const phantomReportsRouter = Router();

const reportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many reports. Try again in a minute." },
});

const reportSchema = z.object({
  name: z.string().min(1).max(214),
  ecosystem: z.enum(["npm", "pypi"]),
});

phantomReportsRouter.post(
  "/phantom-reports",
  reportLimiter,
  validateBody(reportSchema),
  async (req, res, next) => {
    try {
      const { name, ecosystem } = req.body as z.infer<typeof reportSchema>;
      await recordPhantomReport(name, ecosystem);
      // 204, not the row: the reporter needs nothing back, and echoing counts
      // would let anyone probe what other people have reported.
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
