import path from "node:path";
import express from "express";
import cors from "cors";
import { config } from "./lib/config.js";
import { HttpError } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { githubAuthRouter } from "./routes/githubAuth.js";
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

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", publicBadgeRouter); // no auth — README-embeddable SVG
app.use("/api", cliUploadRouter); // no JWT — authed by per-repo CLI token
app.use("/api", mcpAlternativesRouter); // no JWT — authed by per-repo CLI token
app.use("/api", phantomReportsRouter); // no auth — opt-in telemetry, name+ecosystem only
app.use("/api/auth", authRouter);
app.use("/api/auth", githubAuthRouter);
app.use("/api/orgs", orgsRouter);
app.use("/api", reposRouter);
app.use("/api", scansRouter);
app.use("/api", githubRouter);
app.use("/api", billingRouter);
app.use("/api", badgeRouter);
app.use("/api", cliTokenRouter);

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
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  },
);

warnIfGithubAppMisconfigured();

app.listen(config.port, () => {
  console.log(`CodeAudit API listening on :${config.port}`);
});
