import type { AppLogger } from '../application/ports';
import { errorFields } from '../observability/logger';

/**
 * Laço simples: executa `tick`, espera `intervalMs`, repete. Se o tick
 * processou um lote cheio, roda de novo sem esperar (drena o atraso).
 * `stop()` interrompe a espera e aguarda o tick em andamento terminar.
 */
export class PeriodicWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<{ busy: boolean }>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ worker: this.name }, 'worker started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info({ worker: this.name }, 'worker stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = (await this.tick()).busy;
      } catch (error) {
        this.logger.warn({ worker: this.name, ...errorFields(error) }, 'worker tick failed');
      }
      if (!this.running) break;
      if (!busy) await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.intervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
