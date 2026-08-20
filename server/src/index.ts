import path from "node:path";
import express from "express";
import cors from "cors";
import { config } from "./lib/config.js";
import { HttpError } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { githubAuthRouter } from "./routes/githubAuth.js";
import { googleAuthRouter } from "./routes/googleAuth.js";
import { orgsRouter } from "./routes/orgs.js";
import { reposRouter } from "./routes/repos.js";
import { scansRouter } from "./routes/scans.js";
import { githubRouter } from "./routes/github.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { billingRouter, stripeWebhookRouter } from "./routes/billing.js";
import { badgeRouter, publicBadgeRouter } from "./routes/badge.js";
import { cliTokenRouter, cliUploadRouter } from "./routes/cliScans.js";
import { mcpAlternativesRouter } from "./routes/mcpAlternatives.js";
import { phantomReportsRouter } from "./routes/phantomReports.js";
import { adminRouter } from "./routes/admin/index.js";
import { trackActivity } from "./middleware/activity.js";
import { normalizePath } from "./lib/requestContext.js";
import { logError } from "./services/systemEvents.js";
import { warnIfGithubAppMisconfigured } from "./services/github.js";

const app = express();

// In production this sits behind exactly one reverse proxy (Caddy on the
// single-EC2 deploy, the ALB on ECS). Without this, req.ip is the proxy's
// address on every request, so every IP-keyed rate limiter shares a single
// bucket and one noisy caller locks out everyone. The value is the number of
// trusted hops: keep it exact rather than `true`, which would trust a
// client-supplied X-Forwarded-For and let anyone forge their way around the
// limiter.
app.set("trust proxy", 1);

app.use(cors({ origin: config.appUrl }));

// Webhooks need the raw body for HMAC verification — mounted before express.json().
app.use("/api/webhooks", webhooksRouter);
app.use("/api/webhooks", stripeWebhookRouter);

app.use(express.json({ limit: "100kb" }));

// Opens the request-scoped context every audit entry is written against, and
// records the activity log when the response finishes. Mounted after the
// webhook routers on purpose — those carry no actor and are excluded anyway.
app.use(trackActivity);

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", publicBadgeRouter); // no auth — README-embeddable SVG
app.use("/api", cliUploadRouter); // no JWT — authed by per-repo CLI token
app.use("/api", mcpAlternativesRouter); // no JWT — authed by per-repo CLI token
app.use("/api", phantomReportsRouter); // no auth — opt-in telemetry, name+ecosystem only
app.use("/api/auth", authRouter);
app.use("/api/auth", githubAuthRouter);
app.use("/api/auth", googleAuthRouter);
app.use("/api/orgs", orgsRouter);
app.use("/api", reposRouter);
app.use("/api", scansRouter);
app.use("/api", githubRouter);
app.use("/api", billingRouter);
app.use("/api", badgeRouter);
app.use("/api", cliTokenRouter);
// Platform operator console. The router carries its own guard — see routes/admin/index.ts.
app.use("/api/admin", adminRouter);

// Same-origin static hosting of the built React app. When WEB_DIST_DIR is set
// (production single-container deploy), the API serves the web bundle and falls
// back to index.html for client-side routes. Unset in local dev, where Vite
// serves the web app on its own port and proxies /api here.
if (config.webDistDir) {
  app.use(express.static(config.webDistDir));
  app.use((req, res, next) => {
    // Never let the SPA fallback swallow API 404s or non-GET requests.
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(config.webDistDir, "index.html"));
  });
}

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.use(
  (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    // Bad *input* is a 400, not a server fault. Two cases were returning 500
    // and reading, to anyone fuzzing the API, as unhandled crashes:
    //   - a malformed JSON body (express.json throws a SyntaxError tagged
    //     entity.parse.failed);
    //   - a non-UUID value in a path param, which Postgres rejects with
    //     SQLSTATE 22P02 (invalid_text_representation). This is NOT injection
    //     — the query is parameterised, so the value never reaches the SQL as
    //     code — but the 500 it produced looked like one to a reviewer.
    const e = err as { type?: string; code?: string; status?: number };
    if (e?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body is not valid JSON." });
    }
    if (e?.code === "22P02") {
      return res.status(400).json({ error: "A path parameter was malformed." });
    }
    // A 500 is by definition a bug we did not anticipate, which makes it the
    // single most valuable thing in the operator log. Until now it reached
    // stderr on one container and was gone with it.
    console.error(err);
    void logError("api", "request.unhandled_error", err, {
      userId: req.user?.id ?? null,
      context: { method: req.method, path: normalizePath(req.originalUrl || req.path) },
    });
    res.status(500).json({ error: "Internal server error" });
  },
);

warnIfGithubAppMisconfigured();

app.listen(config.port, () => {
  console.log(`CodeAudit API listening on :${config.port}`);
});
