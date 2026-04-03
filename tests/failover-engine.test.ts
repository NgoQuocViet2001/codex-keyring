import { describe, expect, it } from "vitest";
import { classifyFailure, pickNextAlias, shouldAutoSwitch } from "../src/core/failover-engine.js";

describe("failover-engine", () => {
  it("classifies supported quota and auth failures", () => {
    expect(classifyFailure("429 rate limit exceeded")).toBe("rate-limited");
    expect(classifyFailure("Your workspace policy blocks this action")).toBe("workspace-mismatch");
    expect(classifyFailure("Unauthorized: expired token")).toBe("auth-expired");
    expect(classifyFailure("quota exhausted for this plan")).toBe("quota-exhausted");
    expect(classifyFailure('{"type":"usage_limit_reached"}')).toBe("quota-exhausted");
    expect(classifyFailure("Mình muốn thêm quota 5h và quota tuần cho command stats")).toBeUndefined();
  });

  it("only auto-switches for supported reasons", () => {
    expect(shouldAutoSwitch("rate-limited")).toBe(true);
    expect(shouldAutoSwitch("manual")).toBe(false);
    expect(shouldAutoSwitch(undefined)).toBe(false);
  });

  it("selects the next alias by priority while skipping cooldown", () => {
    const next = pickNextAlias(
      "work",
      [
        {
          active: true,
          meta: { alias: "work", priority: 10, displayName: "work", fingerprint: "a", authMode: "chatgpt", createdAt: "", updatedAt: "" },
          snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
          stats: { alias: "work", authMode: "chatgpt", active: true, health: "cooldown", confidence: "exact", cooldownUntil: "2999-01-01T00:00:00.000Z", windowType: "rolling-24h" },
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
      ],
      { mode: "balanced", reason: "quota-exhausted" },
    );

    expect(next).toBe("night");
  });

  it("prefers the alias with the most 5h quota during reactive failover", () => {
    const next = pickNextAlias(
      "work",
      [
        {
          active: true,
          meta: { alias: "work", priority: 10, displayName: "work", fingerprint: "a", authMode: "chatgpt", createdAt: "", updatedAt: "" },
          snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
          stats: {
            alias: "work",
            authMode: "chatgpt",
            active: true,
            health: "cooldown",
            confidence: "exact",
            limit5hRemainingPercent: 0,
            limit5hResetAt: "2999-01-01T00:00:00.000Z",
            windowType: "codex-rate-limits",
          },
        },
        {
          active: false,
          meta: { alias: "backup", priority: 20, displayName: "backup", fingerprint: "b", authMode: "chatgpt", createdAt: "", updatedAt: "" },
          snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
          stats: {
            alias: "backup",
            authMode: "chatgpt",
            active: false,
            health: "ready",
            confidence: "exact",
            limit5hRemainingPercent: 58,
            limit5hResetAt: "2999-01-01T00:00:00.000Z",
            limitWeekRemainingPercent: 92,
            windowType: "codex-rate-limits",
          },
        },
        {
          active: false,
          meta: { alias: "night", priority: 30, displayName: "night", fingerprint: "c", authMode: "chatgpt", createdAt: "", updatedAt: "" },
          snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
          stats: {
            alias: "night",
            authMode: "chatgpt",
            active: false,
            health: "ready",
            confidence: "exact",
            limit5hRemainingPercent: 21,
            limit5hResetAt: "2999-01-01T00:00:00.000Z",
            limitWeekRemainingPercent: 97,
            windowType: "codex-rate-limits",
          },
        },
      ],
      { mode: "balanced", reason: "quota-exhausted" },
    );

    expect(next).toBe("backup");
  });

  it("rebalances early in balanced mode but not in sequential mode", () => {
    const records = [
      {
        active: true,
        meta: { alias: "work", priority: 10, displayName: "work", fingerprint: "a", authMode: "chatgpt", createdAt: "", updatedAt: "" },
        snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
        stats: {
          alias: "work",
          authMode: "chatgpt",
          active: true,
          health: "active",
          confidence: "exact",
          limit5hRemainingPercent: 42,
          limit5hResetAt: "2999-01-01T00:00:00.000Z",
          limitWeekRemainingPercent: 95,
          windowType: "codex-rate-limits",
        },
      },
      {
        active: false,
        meta: { alias: "backup", priority: 20, displayName: "backup", fingerprint: "b", authMode: "chatgpt", createdAt: "", updatedAt: "" },
        snapshot: { schemaVersion: 1, capturedAt: "", source: "active-auth", auth: { auth_mode: "chatgpt" } },
        stats: {
          alias: "backup",
          authMode: "chatgpt",
          active: false,
          health: "ready",
          confidence: "exact",
          limit5hRemainingPercent: 81,
          limit5hResetAt: "2999-01-01T00:00:00.000Z",
          limitWeekRemainingPercent: 94,
          windowType: "codex-rate-limits",
        },
      },
    ];

    expect(pickNextAlias("work", records, { mode: "balanced" })).toBe("backup");
    expect(pickNextAlias("work", records, { mode: "sequential" })).toBeUndefined();
  });
});
