import type { Subprocess } from 'bun';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOG_DIR = resolve(ROOT, 'test/.logs');

export interface Instance {
  id: string;
  url: string;
  proc: Subprocess;
  /** SIGTERM e espera sair; devolve o exit code. */
  stop(): Promise<number | null>;
  /** SIGKILL: morte abrupta, sem shutdown gracioso. */
  kill(): Promise<void>;
}

let nextPort = 4100 + Math.floor(Math.random() * 500);

/**
 * Sobe a aplicação como PROCESSO separado (não é o mesmo event loop do teste):
 * cada instância tem seu próprio pool de conexões, consumidor SQS e workers.
 */
export async function startInstance(id: string, env: Record<string, string>): Promise<Instance> {
  mkdirSync(LOG_DIR, { recursive: true });
  const port = nextPort++;
  const logFile = Bun.file(resolve(LOG_DIR, `${id}-${port}.log`));
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), INSTANCE_ID: id },
    stdout: logFile,
    stderr: logFile,
  });
  const url = `http://localhost:${port}`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`instance ${id} exited early (${proc.exitCode}); see test/.logs`);
    try {
      const r = await fetch(`${url}/health/ready`);
      if (r.status === 200) break;
    } catch {
      // ainda subindo
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`instance ${id} not ready in time`);
    }
    await Bun.sleep(200);
  }

  return {
    id,
    url,
    proc,
    async stop() {
      proc.kill('SIGTERM');
      return proc.exited;
    },
    async kill() {
      proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}
