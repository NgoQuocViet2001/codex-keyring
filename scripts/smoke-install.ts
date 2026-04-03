#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolvePackageRoot } from "../src/platform/codex-home.js";

const packageRoot = await resolvePackageRoot(fileURLToPath(new URL("..", import.meta.url)));
const files = await readdir(packageRoot);
const tgzFiles = files.filter((file: string) => file.endsWith(".tgz")).sort();

console.log(`Package root : ${packageRoot}`);
console.log(`Has dist     : ${files.includes("dist") ? "yes" : "no"}`);
console.log(`Has plugin   : ${files.includes(".codex-plugin") ? "yes" : "no"}`);
console.log(`Tarballs     : ${tgzFiles.length > 0 ? tgzFiles.join(", ") : "(none found)"}`);

if (tgzFiles.length > 0) {
  const latest = tgzFiles.at(-1);
  console.log("");
  console.log("Suggested next steps:");
  console.log(`npm install -g ./${latest}`);
  console.log("codex-keyring install");
}
