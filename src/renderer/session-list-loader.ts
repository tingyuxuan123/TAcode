/** 合并并发请求；本地修改开始/结束时递增版本，迟到列表不能覆盖操作结果。 */
export class SessionListLoader<T> {
  private version = 0;
  private requested = false;
  private job?: Promise<void>;
  constructor(private readonly load: () => Promise<T>, private readonly apply: (value: T) => void) {}
  invalidate(): void { this.version++; }
  refresh(): Promise<void> {
    this.requested = true;
    if (!this.job) this.job = (async () => {
      while (this.requested) {
        this.requested = false;
        const version = this.version;
        const value = await this.load();
        if (version === this.version) this.apply(value);
      }
    })().finally(() => { this.job = undefined; });
    return this.job;
  }
}
