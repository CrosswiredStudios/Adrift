/**
 * Priority job pool for the terrain workers.
 *
 * Jobs carry a priority (lower = sooner, e.g. distance to the camera) and a
 * key; requesting a key that is already queued just updates its priority,
 * and `cancel` drops queued jobs that are no longer wanted (the camera flew
 * on). Every worker gets the same `init` message, so any worker can serve any
 * body. Without Worker support (unit tests) jobs run synchronously on a
 * microtask, through the same handlers.
 */
import { runJob, type JobRequest, type JobResult } from "./terrainJobs";

interface Pending {
  key: string;
  job: JobRequest;
  priority: number;
  resolve: (r: JobResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker | null;
  busy: number;
}

export interface WorkerPoolStats {
  workers: number;
  queued: number;
  inFlight: number;
  completed: number;
}

export class TerrainWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue = new Map<string, Pending>();
  private readonly inFlight = new Map<number, Pending>();
  private nextId = 1;
  private completed = 0;
  /** Max jobs a worker holds at once (keeps priorities responsive). */
  private readonly perWorker = 2;

  constructor(workerFactory: (() => Worker) | null, count: number) {
    const n = workerFactory ? Math.max(1, count) : 1;
    for (let i = 0; i < n; i++) {
      const worker = workerFactory ? workerFactory() : null;
      const slot: Slot = { worker, busy: 0 };
      if (worker) {
        worker.onmessage = (
          e: MessageEvent<{ id: number; ok: boolean; result?: JobResult; error?: string }>,
        ) => this.onResult(slot, e.data);
        worker.onerror = (e) => console.error("terrain worker error", e.message);
      }
      this.slots.push(slot);
    }
  }

  /** Send body shapes to every worker (must be called before other jobs). */
  init(job: Extract<JobRequest, { kind: "init" }>): void {
    // The main thread also keeps the shapes (synchronous root chunks, fallback).
    runJob(job);
    for (const s of this.slots) if (s.worker) s.worker.postMessage({ id: 0, job });
  }

  /** Update the priority of a queued job (no-op if it already started). */
  reprioritize(key: string, priority: number): void {
    const p = this.queue.get(key);
    if (p) p.priority = priority;
  }

  /** Queue (or re-prioritise) a job. Resolves with the worker's result. */
  request(key: string, job: JobRequest, priority: number): Promise<JobResult> {
    const existing = this.queue.get(key);
    if (existing) {
      existing.priority = priority;
      return new Promise((resolve, reject) => {
        const prevResolve = existing.resolve;
        const prevReject = existing.reject;
        existing.resolve = (r) => {
          prevResolve(r);
          resolve(r);
        };
        existing.reject = (e) => {
          prevReject(e);
          reject(e);
        };
      });
    }
    return new Promise((resolve, reject) => {
      this.queue.set(key, { key, job, priority, resolve, reject });
      this.pump();
    });
  }

  isQueued(key: string): boolean {
    return this.queue.has(key);
  }

  /** Drop queued (not yet started) jobs whose key fails `keep`. */
  prune(keep: (key: string) => boolean): void {
    for (const [key, p] of this.queue) {
      if (!keep(key)) {
        this.queue.delete(key);
        p.reject(new CancelledError(key));
      }
    }
  }

  private pump(): void {
    if (!this.queue.size) return;
    for (const slot of this.slots) {
      while (slot.busy < this.perWorker && this.queue.size) {
        let best: Pending | null = null;
        for (const p of this.queue.values()) if (!best || p.priority < best.priority) best = p;
        if (!best) return;
        this.queue.delete(best.key);
        const id = this.nextId++;
        this.inFlight.set(id, best);
        slot.busy++;
        if (slot.worker) slot.worker.postMessage({ id, job: best.job });
        else {
          const job = best.job;
          queueMicrotask(() => {
            try {
              const { result } = runJob(job);
              this.onResult(slot, { id, ok: true, result });
            } catch (err) {
              this.onResult(slot, { id, ok: false, error: String(err) });
            }
          });
        }
      }
    }
  }

  private onResult(slot: Slot, msg: { id: number; ok: boolean; result?: JobResult; error?: string }): void {
    if (msg.id === 0) return; // init ack
    const p = this.inFlight.get(msg.id);
    this.inFlight.delete(msg.id);
    slot.busy = Math.max(0, slot.busy - 1);
    this.completed++;
    if (p) {
      if (msg.ok && msg.result) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "terrain job failed"));
    }
    this.pump();
  }

  stats(): WorkerPoolStats {
    return {
      workers: this.slots.filter((s) => s.worker).length,
      queued: this.queue.size,
      inFlight: this.inFlight.size,
      completed: this.completed,
    };
  }

  dispose(): void {
    for (const s of this.slots) s.worker?.terminate();
    this.queue.clear();
    this.inFlight.clear();
  }
}

export class CancelledError extends Error {
  constructor(key: string) {
    super(`cancelled: ${key}`);
    this.name = "CancelledError";
  }
}

/** Default factory: Vite bundles terrainWorker.ts as a module worker. */
export function createTerrainWorker(): Worker {
  return new Worker(new URL("./terrainWorker.ts", import.meta.url), { type: "module" });
}
