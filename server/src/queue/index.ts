import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../lib/config.js";

export const redisConnection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export interface ScanJobData {
  scanJobId: string;
}

export const scanQueue = new Queue<ScanJobData>("scan", { connection: redisConnection });

export interface PrCommentJobData {
  scanJobId: string;
}

export const prCommentQueue = new Queue<PrCommentJobData>("pr-comment", {
  connection: redisConnection,
});

export interface AutofixJobData {
  scanJobId: string;
  requestedBy: string; // user id — autofix only ever runs on explicit human request
}

export const autofixQueue = new Queue<AutofixJobData>("autofix", {
  connection: redisConnection,
});
