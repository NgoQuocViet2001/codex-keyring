import { describe, expect, it } from "vitest";
import { classifyFailure, pickNextAlias, shouldAutoSwitch } from "../src/core/failover-engine.js";
import type { AccountRecord } from "../src/core/types.js";

function record(
  alias: string,
  options: {
    active?: boolean;
    manualOnly?: boolean;
    priority?: number;
    cooldownUntil?: string;
    limit5hRemainingPercent?: number;
    limit5hResetAt?: string;
    limitWeekRemainingPercent?: number;
    limitWeekResetAt?: string;
    health?: "active" | "ready" | "cooldown" | "degraded" | "unknown";
  } = {},
): AccountRecord {
  return {
    active: options.active ?? false,
    meta: {
      alias,
      displayName: alias,
      priority: options.priority ?? 100,
      manualOnly: options.manualOnly ?? false,
      fingerprint: alias,
      authMode: "chatgpt",
      createdAt: "",
      updatedAt: "",
    },
    snapshot: {
      schemaVersion: 1,
      capturedAt: "",
      source: "active-auth",
      auth: { auth_mode: "chatgpt" },
    },
    stats: {
      alias,
      authMode: "chatgpt",
      active: options.active ?? false,
      health: options.health ?? (options.active ? "active" : "ready"),
      confidence: "exact",
      cooldownUntil: options.cooldownUntil,
      limit5hRemainingPercent: options.limit5hRemainingPercent,
      limit5hResetAt: options.limit5hResetAt,
      limitWeekRemainingPercent: options.limitWeekRemainingPercent,
      limitWeekResetAt: options.limitWeekResetAt,
      windowType: "codex-rate-limits",
    },
  };
}

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

describe("failover-engine", () => {
  it("classifies supported quota and auth failures", () => {
    expect(classifyFailure("429 rate limit exceeded")).toBe("rate-limited");
    expect(classifyFailure("Your workspace policy blocks this action")).toBe("workspace-mismatch");
    expect(classifyFailure("Unauthorized: expired token")).toBe("auth-expired");
    expect(classifyFailure("quota exhausted for this plan")).toBe("quota-exhausted");
    expect(classifyFailure('{"type":"usage_limit_reached"}')).toBe("quota-exhausted");
    expect(classifyFailure("OpenAI API error: insufficient quota")).toBe("quota-exhausted");
    expect(classifyFailure('{"error":{"code":"insufficient_quota"}}')).toBe("quota-exhausted");
    expect(classifyFailure("Mình muốn thêm quota 5h và quota tuần cho command stats")).toBeUndefined();
  });

  it("classifies common 403 errors as workspace mismatch", () => {
    expect(classifyFailure("HTTP 403 Forbidden")).toBe("workspace-mismatch");
    expect(classifyFailure('{"status_code":403,"message":"forbidden"}')).toBe("workspace-mismatch");
  });

  it("only auto-switches for supported reasons", () => {
    expect(shouldAutoSwitch("rate-limited")).toBe(true);
    expect(shouldAutoSwitch("manual")).toBe(false);
    expect(shouldAutoSwitch(undefined)).toBe(false);
  });

  it("selects the next alias while skipping cooldown", () => {
    const next = pickNextAlias(
      "work",
      [
        record("work", { active: true, priority: 10, cooldownUntil: FAR_FUTURE, health: "cooldown" }),
        record("backup", { priority: 20, cooldownUntil: FAR_FUTURE, health: "cooldown" }),
        record("night", { priority: 30 }),
      ],
      { mode: "balanced", reason: "quota-exhausted" },
    );

    expect(next).toBe("night");
  });

  it("uses both 5h and weekly headroom during reactive failover", () => {
    const next = pickNextAlias(
      "work",
      [
        record("work", {
          active: true,
          priority: 10,
          health: "cooldown",
          limit5hRemainingPercent: 0,
          limit5hResetAt: FAR_FUTURE,
          limitWeekRemainingPercent: 85,
          limitWeekResetAt: FAR_FUTURE,
        }),
        record("backup", {
          priority: 20,
          limit5hRemainingPercent: 58,
          limit5hResetAt: FAR_FUTURE,
          limitWeekRemainingPercent: 18,
          limitWeekResetAt: FAR_FUTURE,
        }),
        record("night", {
          priority: 30,
          limit5hRemainingPercent: 54,
          limit5hResetAt: FAR_FUTURE,
          limitWeekRemainingPercent: 83,
          limitWeekResetAt: FAR_FUTURE,
        }),
      ],
      { mode: "balanced", reason: "quota-exhausted" },
    );

    expect(next).toBe("night");
  });

  it("rebalances at the 20 percent 5h threshold in balanced mode but not in sequential mode", () => {
    const records = [
      record("work", {
        active: true,
        priority: 10,
        limit5hRemainingPercent: 18,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 95,
        limitWeekResetAt: FAR_FUTURE,
      }),
      record("backup", {
        priority: 20,
        limit5hRemainingPercent: 81,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 94,
        limitWeekResetAt: FAR_FUTURE,
      }),
    ];

    expect(pickNextAlias("work", records, { mode: "balanced" })).toBe("backup");
    expect(pickNextAlias("work", records, { mode: "sequential" })).toBeUndefined();
  });

  it("does not rebalance above the 20 percent 5h threshold", () => {
    const records = [
      record("work", {
        active: true,
        priority: 10,
        limit5hRemainingPercent: 42,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 95,
        limitWeekResetAt: FAR_FUTURE,
      }),
      record("backup", {
        priority: 20,
        limit5hRemainingPercent: 81,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 94,
        limitWeekResetAt: FAR_FUTURE,
      }),
    ];

    expect(pickNextAlias("work", records, { mode: "balanced" })).toBeUndefined();
  });

  it("still rebalances when weekly headroom is critically low", () => {
    const records = [
      record("work", {
        active: true,
        priority: 10,
        limit5hRemainingPercent: 72,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 8,
        limitWeekResetAt: FAR_FUTURE,
      }),
      record("backup", {
        priority: 20,
        limit5hRemainingPercent: 55,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 42,
        limitWeekResetAt: FAR_FUTURE,
      }),
    ];

    expect(pickNextAlias("work", records, { mode: "balanced" })).toBe("backup");
  });

  it("does not rebalance when rebalancing is disabled for stable startup checks", () => {
    const records = [
      record("work", {
        active: true,
        priority: 10,
        limit5hRemainingPercent: 18,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 95,
        limitWeekResetAt: FAR_FUTURE,
      }),
      record("backup", {
        priority: 20,
        limit5hRemainingPercent: 81,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 94,
        limitWeekResetAt: FAR_FUTURE,
      }),
    ];

    expect(pickNextAlias("work", records, { mode: "balanced", allowRebalance: false })).toBeUndefined();
  });

  it("never auto-switches aliases marked manual-only", () => {
    const records = [
      record("work", {
        active: true,
        manualOnly: true,
        limit5hRemainingPercent: 0,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 80,
        limitWeekResetAt: FAR_FUTURE,
      }),
      record("backup", {
        limit5hRemainingPercent: 88,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 90,
        limitWeekResetAt: FAR_FUTURE,
      }),
    ];

    expect(pickNextAlias("work", records, { mode: "balanced", reason: "quota-exhausted" })).toBeUndefined();
  });

  it("ignores manual-only candidates during auto-switch", () => {
    const records = [
      record("work", {
        active: true,
        limit5hRemainingPercent: 0,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 70,
        limitWeekResetAt: FAR_FUTURE,
      }),
      record("backup", {
        manualOnly: true,
        limit5hRemainingPercent: 95,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 95,
        limitWeekResetAt: FAR_FUTURE,
      }),
      record("night", {
        limit5hRemainingPercent: 60,
        limit5hResetAt: FAR_FUTURE,
        limitWeekRemainingPercent: 60,
        limitWeekResetAt: FAR_FUTURE,
      }),
    ];

    expect(pickNextAlias("work", records, { mode: "balanced", reason: "quota-exhausted" })).toBe("night");
  });
});
