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

const app = express();
app.use(cors({ origin: config.appUrl }));

// Webhooks need the raw body for HMAC verification — mounted before express.json().
app.use("/api/webhooks", webhooksRouter);
app.use("/api/webhooks", stripeWebhookRouter);

app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", publicBadgeRouter); // no auth — README-embeddable SVG
app.use("/api/auth", authRouter);
app.use("/api/auth", githubAuthRouter);
app.use("/api/orgs", orgsRouter);
app.use("/api", reposRouter);
app.use("/api", scansRouter);
app.use("/api", githubRouter);
app.use("/api", billingRouter);
app.use("/api", badgeRouter);

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

app.listen(config.port, () => {
  console.log(`CodeAudit API listening on :${config.port}`);
});
