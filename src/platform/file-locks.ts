import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  const started = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        return await action();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`, { cause: error });
      }

      await sleep(100);
    }
  }
}
