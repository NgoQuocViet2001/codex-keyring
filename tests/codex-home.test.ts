import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexInvocationForPlatform, resolvePackageRoot } from "../src/platform/codex-home.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("resolvePackageRoot", () => {
  it("skips nested dist package.json when required payload entries only exist at the package root", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-accounts-"));

    const packageRoot = path.join(tempDir, "package-root");
    const distRoot = path.join(packageRoot, "dist");
    const commandRoot = path.join(distRoot, "src", "cli", "commands");

    await mkdir(commandRoot, { recursive: true });
    await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
    await mkdir(path.join(packageRoot, "assets"), { recursive: true });
    await mkdir(path.join(packageRoot, "skills"), { recursive: true });

    await writeFile(path.join(packageRoot, "package.json"), "{}\n", "utf8");
    await writeFile(path.join(packageRoot, ".mcp.json"), "{}\n", "utf8");
    await writeFile(path.join(distRoot, "package.json"), "{}\n", "utf8");

    const resolved = await resolvePackageRoot(commandRoot, [".codex-plugin", ".mcp.json", "assets", "skills"]);
    expect(resolved).toBe(packageRoot);
  });
});

describe("createCodexInvocationForPlatform", () => {
  it("builds a shell command for Windows Codex invocations", () => {
    const invocation = createCodexInvocationForPlatform("win32", ["login", "-c", 'cli_auth_credentials_store="file"']);

    expect(invocation).toEqual({
      command: 'codex login -c "cli_auth_credentials_store=\\"file\\""',
      args: [],
      shell: true,
    });
  });

  it.each(["linux", "darwin"] satisfies NodeJS.Platform[])(
    "uses direct binary invocation on %s",
    (platform: NodeJS.Platform) => {
      const invocation = createCodexInvocationForPlatform(platform, ["--version"]);

      expect(invocation).toEqual({
        command: "codex",
        args: ["--version"],
        shell: false,
      });
    },
  );
});
