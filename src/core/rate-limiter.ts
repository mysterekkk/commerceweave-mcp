/** Sliding-window limiter: at most `max` acquisitions per `windowMs`, serialised FIFO. */
export class RateLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  acquire(signal?: AbortSignal): Promise<void> {
    const run = async () => {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const t = this.now();
        this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
        if (this.stamps.length < this.max) {
          this.stamps.push(t);
          return;
        }
        const wait = (this.stamps[0] as number) + this.windowMs - t;
        await this.sleep(Math.max(wait, 1));
      }
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Push the window forward after the server asked us to back off. */
  penalize(ms: number) {
    const t = this.now();
    this.stamps = Array.from({ length: this.max }, () => t + ms - this.windowMs);
  }
}
