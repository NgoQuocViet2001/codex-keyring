import { describe, expect, it } from "vitest";
import { shouldPreserveInteractiveCodexTty } from "../src/cli/commands/exec.js";

describe("exec command tty preservation", () => {
  it("preserves tty for interactive codex sessions", () => {
    expect(
      shouldPreserveInteractiveCodexTty("codex", [], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toBe(true);

    expect(
      shouldPreserveInteractiveCodexTty("codex", ["--model", "gpt-5.4", "--no-alt-screen"], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toBe(true);

    expect(
      shouldPreserveInteractiveCodexTty("codex", ["resume"], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toBe(true);
  });

  it("does not preserve tty for non-interactive codex subcommands or non-tty parents", () => {
    expect(
      shouldPreserveInteractiveCodexTty("codex", ["exec", "--help"], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toBe(false);

    expect(
      shouldPreserveInteractiveCodexTty("codex", ["review"], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toBe(false);

    expect(
      shouldPreserveInteractiveCodexTty("codex", [], {
        stdinIsTTY: true,
        stdoutIsTTY: false,
        stderrIsTTY: true,
      }),
    ).toBe(false);

    expect(
      shouldPreserveInteractiveCodexTty("node", ["script.js"], {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stderrIsTTY: true,
      }),
    ).toBe(false);
  });
});
