#!/usr/bin/env node
import { AccountStore } from "../src/core/account-store.js";
import { getCodexEnvironment } from "../src/platform/codex-home.js";
import { uninstallPlugin } from "../src/platform/npm-installer.js";

const env = getCodexEnvironment();
const store = new AccountStore(env);
await store.ensureStore();
await uninstallPlugin(store);
console.log("codex-keyring removed from personal marketplace.");
