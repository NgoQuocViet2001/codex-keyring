import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareVersions, maybePromptForUpdate, shouldCheckForUpdates } from "../src/core/update-notifier.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.restoreAllMocks();
});

function fetchVersion(version: string) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ version }),
  })) as unknown as typeof fetch;
}

describe("update-notifier", () => {
  it("compares semver-like versions numerically", () => {
    expect(compareVersions("0.5.5", "0.6.0")).toBeLessThan(0);
    expect(compareVersions("0.6.0", "0.5.5")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("skips update prompts for json, help, version, and mcp flows", () => {
    expect(shouldCheckForUpdates(["node", "cli", "status", "--json"], true, true)).toBe(false);
    expect(shouldCheckForUpdates(["node", "cli", "mcp"], true, true)).toBe(false);
    expect(shouldCheckForUpdates(["node", "cli", "--help"], true, true)).toBe(false);
    expect(shouldCheckForUpdates(["node", "cli", "--version"], true, true)).toBe(false);
    expect(shouldCheckForUpdates(["node", "cli", "status"], false, true)).toBe(false);
  });

  it("remembers a skipped version and suppresses the same prompt until a newer release appears", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const promptChoice = vi.fn(async () => "skip" as const);

    const first = await maybePromptForUpdate({
      packageName: "codex-keyring",
      currentVersion: "0.5.5",
      storeRoot: tempDir,
      argv: ["node", "cli", "status"],
      stdinTTY: true,
      stdoutTTY: true,
      fetchImpl: fetchVersion("0.6.0"),
      promptChoice,
    });
    const second = await maybePromptForUpdate({
      packageName: "codex-keyring",
      currentVersion: "0.5.5",
      storeRoot: tempDir,
      argv: ["node", "cli", "status"],
      stdinTTY: true,
      stdoutTTY: true,
      fetchImpl: fetchVersion("0.6.0"),
      promptChoice,
    });
    const third = await maybePromptForUpdate({
      packageName: "codex-keyring",
      currentVersion: "0.5.5",
      storeRoot: tempDir,
      argv: ["node", "cli", "status"],
      stdinTTY: true,
      stdoutTTY: true,
      fetchImpl: fetchVersion("0.6.1"),
      promptChoice,
      now: () => new Date("2026-04-05T12:00:00.000Z"),
    });

    expect(first.status).toBe("skip");
    expect(second.status).toBe("noop");
    expect(third.status).toBe("skip");
    expect(promptChoice).toHaveBeenCalledTimes(2);
  });

  it("runs the update installer when the user chooses update now", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-keyring-"));
    const installLatest = vi.fn(async () => true);

    const result = await maybePromptForUpdate({
      packageName: "codex-keyring",
      currentVersion: "0.5.5",
      storeRoot: tempDir,
      argv: ["node", "cli", "status"],
      stdinTTY: true,
      stdoutTTY: true,
      fetchImpl: fetchVersion("0.6.0"),
      promptChoice: async () => "update",
      installLatest,
    });

    expect(result).toMatchObject({
      status: "updated",
      latestVersion: "0.6.0",
    });
    expect(installLatest).toHaveBeenCalledWith("codex-keyring", "0.6.0");
  });
});
