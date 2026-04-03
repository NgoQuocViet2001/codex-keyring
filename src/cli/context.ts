import { AccountStore } from "../core/account-store.js";
import { reconcileHostFailover } from "../core/host-reconciliation.js";
import { getCodexEnvironment } from "../platform/codex-home.js";

export interface CliContext {
  store: AccountStore;
}

export async function createCliContext(): Promise<CliContext> {
  const env = getCodexEnvironment();
  const store = new AccountStore(env);
  await store.ensureStore();
  try {
    await reconcileHostFailover(store);
  } catch {
    // Host-log reconciliation is best-effort and must not block CLI startup.
  }
  return { store };
}
