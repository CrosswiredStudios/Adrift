/**
 * Terrain Web Worker: builds chunk meshes, height maps and vegetation cells
 * off the main thread. See terrainJobs.ts for the handlers.
 */
import { runJob, type JobRequest } from "./terrainJobs";

interface WorkerScope {
  onmessage: ((e: MessageEvent<{ id: number; job: JobRequest }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const { id, job } = e.data;
  try {
    const { result, transfer } = runJob(job);
    scope.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err) });
  }
};
