#!/usr/bin/env node
import { AccountStore } from "../src/core/account-store.js";
import { getCodexEnvironment } from "../src/platform/codex-home.js";
import { ensureFileBackedAuthConfig } from "../src/platform/codex-home.js";

const env = getCodexEnvironment();
const store = new AccountStore(env);
await store.ensureStore();
const state = await store.getState();
const result = await ensureFileBackedAuthConfig(env);
state.managedAuthMode = true;
if (result.previousStore && result.previousStore !== "file") {
  state.originalCliAuthCredentialsStore = result.previousStore;
}
await store.saveState(state);
console.log(JSON.stringify({ ok: true, changed: result.changed, previousStore: result.previousStore }, null, 2));
