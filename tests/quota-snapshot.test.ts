import { describe, expect, it } from "vitest";
import { extractQuotaSnapshotFromText, pickQuotaWindow } from "../src/core/quota-snapshot.js";

describe("quota-snapshot", () => {
  it("parses exact quota data from usage limit headers", () => {
    const snapshot = extractQuotaSnapshotFromText(
      'Received message {"type":"error","error":{"type":"usage_limit_reached","plan_type":"team"},"headers":{"X-Codex-Primary-Used-Percent":"100","X-Codex-Primary-Window-Minutes":"300","X-Codex-Primary-Reset-At":"1775201449","X-Codex-Secondary-Used-Percent":"13","X-Codex-Secondary-Window-Minutes":"10080","X-Codex-Secondary-Reset-At":"1775788249"}}',
      "2026-04-03T05:02:45.000Z",
    );

    expect(snapshot).toMatchObject({
      planType: "team",
      primary: {
        usedPercent: 100,
        remainingPercent: 0,
        windowMinutes: 300,
      },
      secondary: {
        usedPercent: 13,
        remainingPercent: 87,
        windowMinutes: 10080,
      },
    });
  });

  it("parses codex.rate_limits snapshots before hard limit", () => {
    const snapshot = extractQuotaSnapshotFromText(
      'websocket event: {"type":"codex.rate_limits","plan_type":"team","rate_limits":{"allowed":true,"limit_reached":false,"primary":{"used_percent":42,"window_minutes":300,"reset_after_seconds":13893,"reset_at":1775206534},"secondary":{"used_percent":5,"window_minutes":10080,"reset_after_seconds":600693,"reset_at":1775793334}}}',
      "2026-04-03T05:03:59.000Z",
    );

    expect(pickQuotaWindow(snapshot, 300)).toMatchObject({
      usedPercent: 42,
      remainingPercent: 58,
      windowMinutes: 300,
    });
    expect(pickQuotaWindow(snapshot, 10080)).toMatchObject({
      usedPercent: 5,
      remainingPercent: 95,
      windowMinutes: 10080,
    });
  });
});
