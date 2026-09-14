/** Serializes all repository writes that share a Git common directory. */
export class GitWriteQueue {
  private readonly queues = new Map<string, Promise<void>>();

  enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(key) ?? Promise.resolve()).then(job);
    const settled = task.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return task;
  }

  async idle(): Promise<void> { await Promise.all([...this.queues.values()]); }
}
