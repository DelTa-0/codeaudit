import { redisConnection } from "../queue/index.js";

const KEY = "codeaudit:worker:heartbeat";
const INTERVAL_MS = 15_000;
/** Beyond this the worker is reported down rather than merely quiet. */
const STALE_MS = 60_000;

export interface WorkerHeartbeat {
  alive: boolean;
  lastBeatAt: string | null;
  ageSeconds: number | null;
  pid: number | null;
  host: string | null;
  startedAt: string | null;
}

/**
 * Why this exists: a backed-up queue and a dead consumer look identical from
 * the queue depth alone — in both cases the waiting count climbs and nothing
 * completes. The heartbeat is what separates "we are slow" from "nothing is
 * running", which are different incidents with different responses.
 *
 * The key carries a TTL of a few beats, so a worker that dies without cleaning
 * up disappears on its own rather than leaving a stale claim of liveness.
 */
export function startHeartbeat(): NodeJS.Timeout {
  const startedAt = new Date().toISOString();
  const beat = async () => {
    try {
      await redisConnection.set(
        KEY,
        JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          host: process.env.HOSTNAME ?? null,
          startedAt,
        }),
        "PX",
        STALE_MS * 3,
      );
    } catch {
      // Redis being unreachable is itself the outage; the panel will report the
      // worker down, which is the truth.
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), INTERVAL_MS);
  // Never hold the process open just to say it is alive.
  timer.unref();
  return timer;
}

export async function readHeartbeat(): Promise<WorkerHeartbeat> {
  const down: WorkerHeartbeat = {
    alive: false,
    lastBeatAt: null,
    ageSeconds: null,
    pid: null,
    host: null,
    startedAt: null,
  };
  try {
    const raw = await redisConnection.get(KEY);
    if (!raw) return down;
    const parsed = JSON.parse(raw) as {
      at: string;
      pid: number;
      host: string | null;
      startedAt: string;
    };
    const ageMs = Date.now() - new Date(parsed.at).getTime();
    return {
      alive: ageMs < STALE_MS,
      lastBeatAt: parsed.at,
      ageSeconds: Math.round(ageMs / 1000),
      pid: parsed.pid ?? null,
      host: parsed.host ?? null,
      startedAt: parsed.startedAt ?? null,
    };
  } catch {
    return down;
  }
}
