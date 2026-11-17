import type { ControlPlane, ControlPlaneLogger } from "../services/control-plane.js";

export class ControlJobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly control: ControlPlane,
    private readonly pollMs: number,
    private readonly logger: ControlPlaneLogger,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;
    try {
      this.control.recoverExpiredLeases();
      this.control.expireStaleApprovals();
      for (let count = 0; count < 50; count += 1) {
        if (!(await this.control.processNextControlJob())) {
          break;
        }
      }
    } catch (error) {
      this.logger.error({ error }, "Scheduler tick failed");
    } finally {
      this.running = false;
    }
  }
}
