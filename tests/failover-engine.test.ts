import { describe, expect, it } from "vitest";
import { classifyFailure, pickNextAlias, shouldAutoSwitch } from "../src/core/failover-engine.js";

describe("failover-engine", () => {
  it("classifies supported quota and auth failures", () => {
    expect(classifyFailure("429 rate limit exceeded")).toBe("rate-limited");
    expect(classifyFailure("Your workspace policy blocks this action")).toBe("workspace-mismatch");
    expect(classifyFailure("Unauthorized: expired token")).toBe("auth-expired");
    expect(classifyFailure("quota exhausted for this plan")).toBe("quota-exhausted");
    expect(classifyFailure('{"type":"usage_limit_reached"}')).toBe("quota-exhausted");
  });

  it("only auto-switches for supported reasons", () => {
    expect(shouldAutoSwitch("rate-limited")).toBe(true);
    expect(shouldAutoSwitch("manual")).toBe(false);
    expect(shouldAutoSwitch(undefined)).toBe(false);
  });

  it("selects the next alias by priority while skipping cooldown", () => {
    const next = pickNextAlias("work", [
      {
        active: true,
        meta: { alias: "work", priority: 10, displayName: "work", fingerprint: "a", authMode: "chatgpt", createdAt: "", updatedAt: "" },
        snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
      },
      {
        active: false,
        meta: { alias: "backup", priority: 20, displayName: "backup", fingerprint: "b", authMode: "chatgpt", createdAt: "", updatedAt: "" },
        snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
        stats: { alias: "backup", authMode: "chatgpt", active: false, health: "cooldown", confidence: "exact", cooldownUntil: "2999-01-01T00:00:00.000Z", windowType: "rolling-24h" },
      },
      {
        active: false,
        meta: { alias: "night", priority: 30, displayName: "night", fingerprint: "c", authMode: "chatgpt", createdAt: "", updatedAt: "" },
        snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
      },
    ]);

    expect(next).toBe("night");
  });
});
