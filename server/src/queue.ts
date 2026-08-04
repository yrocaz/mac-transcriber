/**
 * In-process FIFO queue, concurrency 1 (spec §5). Jobs are processed strictly
 * in submission order; a job never starts until the previous one has fully
 * settled (success or failure), which is what sidesteps Apple's documented
 * `insufficientResources` limit for concurrent SpeechAnalyzer sessions.
 */
export class JobQueue {
  private readonly pending: string[] = [];
  private draining = false;
  private readonly worker: (id: string) => Promise<void>;

  constructor(worker: (id: string) => Promise<void>) {
    this.worker = worker;
  }

  enqueue(id: string): void {
    this.pending.push(id);
    void this.drain();
  }

  /** Number of jobs waiting behind the one currently processing (if any). */
  get size(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let next: string | undefined;
      while ((next = this.pending.shift()) !== undefined) {
        try {
          await this.worker(next);
        } catch {
          // The worker is expected to translate all failures into a
          // persisted job error; a throw here just protects the queue loop
          // itself from dying so subsequent jobs still get processed.
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
