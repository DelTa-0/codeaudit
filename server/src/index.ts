import express from "express";
import cors from "cors";
import { config } from "./lib/config.js";
import { HttpError } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { orgsRouter } from "./routes/orgs.js";
import { reposRouter } from "./routes/repos.js";
import { scansRouter } from "./routes/scans.js";

const app = express();
app.use(cors({ origin: config.appUrl }));
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/orgs", orgsRouter);
app.use("/api", reposRouter);
app.use("/api", scansRouter);

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
