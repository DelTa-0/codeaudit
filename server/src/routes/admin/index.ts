import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth, requirePlatformAdmin } from "../../middleware/auth.js";
import { overviewRouter } from "./overview.js";
import { adminUsersRouter } from "./users.js";
import { adminOrgsRouter } from "./orgs.js";
import { adminLogsRouter } from "./logs.js";
import { adminProcessesRouter } from "./processes.js";
import { adminHealthRouter } from "./health.js";

export const adminRouter = Router();

/**
 * Its own bucket, separate from the rest of the API. These endpoints are
 * aggregate queries over whole tables and cost meaningfully more than a normal
 * request, so a dashboard left open on a broken auto-refresh should hit a limit
 * rather than sit on the connection pool. Generous enough that a human clicking
 * around and a 15-second poll never notice it.
 */
const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests. Slow down." },
});

/**
 * The guard is mounted here, on the router, rather than on each route. That is
 * the whole point of the file: a new endpoint added to any of the modules below
 * is protected by construction, not by its author remembering to add a
 * middleware. Getting this wrong once is how admin panels leak.
 *
 * `requirePlatformAdmin` answers non-admins with 404 rather than 403 — see the
 * note on its definition.
 */
adminRouter.use(adminLimiter, requireAuth, requirePlatformAdmin);

adminRouter.use(overviewRouter);
adminRouter.use(adminUsersRouter);
adminRouter.use(adminOrgsRouter);
adminRouter.use(adminLogsRouter);
adminRouter.use(adminProcessesRouter);
adminRouter.use(adminHealthRouter);
