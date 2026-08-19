import { Router } from "express";
import { query } from "../../db/pool.js";
import { config } from "../../lib/config.js";
import { redisConnection } from "../../queue/index.js";
import { readHeartbeat } from "../../services/workerHeartbeat.js";

export const adminHealthRouter = Router();

interface Check {
  name: string;
  status: "ok" | "degraded" | "down" | "not_configured";
  detail: string;
  latencyMs?: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; error: string | null }> {
  const start = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - start, error: null };
  } catch (err) {
    return { value: null, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

adminHealthRouter.get("/health", async (_req, res, next) => {
  try {
    const [db, redis, worker] = await Promise.all([
      timed(() => query<{ n: number; version: string }>("SELECT 1 AS n, version() AS version")),
      timed(() => redisConnection.ping()),
      readHeartbeat(),
    ]);

    const checks: Check[] = [
      {
        name: "postgres",
        status: db.error ? "down" : "ok",
        detail: db.error ?? (db.value?.[0]?.version ?? "").split(" ").slice(0, 2).join(" "),
        latencyMs: db.ms,
      },
      {
        name: "redis",
        status: redis.error ? "down" : "ok",
        detail: redis.error ?? `PONG (${config.redisTls ? "TLS" : "plaintext"})`,
        latencyMs: redis.ms,
      },
      {
        // The distinction that matters most on this page: the queue can be
        // perfectly healthy while nothing is consuming it, and from the API's
        // side those look identical.
        name: "worker",
        status: worker.alive ? "ok" : "down",
        detail: worker.alive
          ? `heartbeat ${worker.ageSeconds}s ago (pid ${worker.pid})`
          : worker.lastBeatAt
            ? `no heartbeat for ${worker.ageSeconds}s — worker is not running`
            : "no heartbeat recorded — worker has never started, or Redis is unreachable",
      },
      integration("github app", Boolean(config.github.appId && (config.github.privateKey || config.github.privateKeyPath)),
        config.github.slug ? `slug "${config.github.slug}"` : "no GITHUB_APP_SLUG set — install links will 404"),
      integration("github webhooks", Boolean(config.github.webhookSecret),
        "signature verification enabled"),
      integration("stripe", Boolean(config.stripe.secretKey),
        config.stripe.webhookSecret ? "keys and webhook secret present" : "no webhook secret — plan changes will not sync"),
      integration("llm review", Boolean(config.llm.apiKey),
        `${config.llm.model} (fallback ${config.llm.fallbackModel})`),
    ];

    // Migration state, which is the check that explains the weirdest outages:
    // code deployed ahead of its schema.
    const migrations = await timed(() =>
      query<{ name: string; applied_at: string }>(
        "SELECT name, applied_at FROM schema_migrations ORDER BY name",
      ),
    );

    res.json({
      checks,
      migrations: {
        applied: migrations.value?.map((m) => m.name) ?? [],
        latest: migrations.value?.at(-1)?.name ?? null,
        error: migrations.error,
      },
      runtime: {
        nodeVersion: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        pid: process.pid,
        betaUnlimited: config.betaUnlimited,
        retention: config.retention,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * An unset integration is reported as `not_configured`, never as `down`.
 * Running without Stripe is a deployment choice; reporting it red trains
 * everyone to ignore red.
 */
function integration(name: string, configured: boolean, detail: string): Check {
  return {
    name,
    status: configured ? "ok" : "not_configured",
    detail: configured ? detail : "not configured on this deployment",
  };
}
