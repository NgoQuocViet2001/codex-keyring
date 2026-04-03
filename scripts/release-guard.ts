#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import packageJson from "../package.json" with { type: "json" };
import pluginJson from "../.codex-plugin/plugin.json" with { type: "json" };

const problems: string[] = [];
const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");

if (packageJson.version !== pluginJson.version) {
  problems.push(`Version mismatch: package.json=${packageJson.version}, plugin.json=${pluginJson.version}`);
}

if (!changelog.includes(`## ${packageJson.version}`)) {
  problems.push(`CHANGELOG.md does not contain a section for version ${packageJson.version}`);
}

if (problems.length > 0) {
  console.error("Release guard failed:");
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

console.log("Release guard passed.");
