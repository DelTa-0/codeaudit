import type { Queue } from "bullmq";
import { scanQueue, prCommentQueue, autofixQueue } from "../queue/index.js";

export interface QueueCounts {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
  /** True when the queue could not be reached — reported, never silently zero. */
  unreachable?: boolean;
}

const QUEUES: Record<string, Queue> = {
  scan: scanQueue,
  "pr-comment": prCommentQueue,
  autofix: autofixQueue,
};

export function queueByName(name: string): Queue | null {
  return QUEUES[name] ?? null;
}

/**
 * Live queue depth, read from BullMQ rather than mirrored into Postgres.
 *
 * A stored copy of this could only ever be wrong: the queue is the source of
 * truth and it moves continuously. The one thing worth being careful about is
 * failure — a Redis outage must surface as `unreachable`, not as a reassuring
 * row of zeroes, which is the same shape as a perfectly idle system.
 */
export async function getQueueSnapshot(): Promise<QueueCounts[]> {
  return Promise.all(
    Object.entries(QUEUES).map(async ([name, queue]): Promise<QueueCounts> => {
      try {
        const c = await queue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "completed",
          "failed",
          "paused",
        );
        return {
          name,
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          completed: c.completed ?? 0,
          failed: c.failed ?? 0,
          paused: c.paused ?? 0,
        };
      } catch {
        return {
          name,
          waiting: 0,
          active: 0,
          delayed: 0,
          completed: 0,
          failed: 0,
          paused: 0,
          unreachable: true,
        };
      }
    }),
  );
}
