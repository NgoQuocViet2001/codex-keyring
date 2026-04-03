#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { AccountStore } from "../src/core/account-store.js";
import { getCodexEnvironment } from "../src/platform/codex-home.js";
import { installPlugin } from "../src/platform/npm-installer.js";

const env = getCodexEnvironment();
const store = new AccountStore(env);
await store.ensureStore();
const result = await installPlugin(store, fileURLToPath(new URL("..", import.meta.url)), true);
console.log(JSON.stringify(result, null, 2));
