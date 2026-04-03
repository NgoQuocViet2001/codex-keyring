import type { QuotaSnapshot, QuotaWindowSnapshot } from "./types.js";

function captureNumber(pattern: RegExp, text: string): number | undefined {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function captureText(pattern: RegExp, text: string): string | undefined {
  const captured = pattern.exec(text)?.[1];
  const value = typeof captured === "string" ? captured.trim() : undefined;
  return value ? value : undefined;
}

function toIsoFromEpochSeconds(value?: number): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1_000).toISOString();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function buildWindow(input: {
  usedPercent?: number;
  windowMinutes?: number;
  resetAfterSeconds?: number;
  resetAtSeconds?: number;
}): QuotaWindowSnapshot | undefined {
  if (!Number.isFinite(input.usedPercent) || !Number.isFinite(input.windowMinutes)) {
    return undefined;
  }

  const usedPercent = clampPercent(input.usedPercent ?? 0);
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowMinutes: input.windowMinutes ?? 0,
    resetAfterSeconds: Number.isFinite(input.resetAfterSeconds) ? input.resetAfterSeconds : undefined,
    resetAt: toIsoFromEpochSeconds(input.resetAtSeconds),
  };
}

function extractHeaderWindow(text: string, prefix: "Primary" | "Secondary"): QuotaWindowSnapshot | undefined {
  return buildWindow({
    usedPercent: captureNumber(new RegExp(`"X-Codex-${prefix}-Used-Percent":"(\\d+)"`, "i"), text),
    windowMinutes: captureNumber(new RegExp(`"X-Codex-${prefix}-Window-Minutes":"(\\d+)"`, "i"), text),
    resetAfterSeconds: captureNumber(new RegExp(`"X-Codex-${prefix}-Reset-After-Seconds":"(\\d+)"`, "i"), text),
    resetAtSeconds: captureNumber(new RegExp(`"X-Codex-${prefix}-Reset-At":"(\\d+)"`, "i"), text),
  });
}

function extractRateLimitsWindow(text: string, label: "primary" | "secondary"): QuotaWindowSnapshot | undefined {
  return buildWindow({
    usedPercent: captureNumber(new RegExp(`"${label}"\\s*:\\s*\\{[^{}]*"used_percent"\\s*:\\s*(\\d+)`, "i"), text),
    windowMinutes: captureNumber(new RegExp(`"${label}"\\s*:\\s*\\{[^{}]*"window_minutes"\\s*:\\s*(\\d+)`, "i"), text),
    resetAfterSeconds: captureNumber(
      new RegExp(`"${label}"\\s*:\\s*\\{[^{}]*"reset_after_seconds"\\s*:\\s*(\\d+)`, "i"),
      text,
    ),
    resetAtSeconds: captureNumber(new RegExp(`"${label}"\\s*:\\s*\\{[^{}]*"reset_at"\\s*:\\s*(\\d+)`, "i"), text),
  });
}

export function extractQuotaSnapshotFromText(
  text: string,
  capturedAt = new Date().toISOString(),
  source: QuotaSnapshot["source"] = "codex-host-log",
): QuotaSnapshot | undefined {
  const primary = extractRateLimitsWindow(text, "primary") ?? extractHeaderWindow(text, "Primary");
  const secondary = extractRateLimitsWindow(text, "secondary") ?? extractHeaderWindow(text, "Secondary");

  if (!primary && !secondary) {
    return undefined;
  }

  return {
    capturedAt,
    source,
    activeLimit: captureText(/"X-Codex-Active-Limit":"([^"]+)"/i, text),
    planType: captureText(/"plan_type":"([^"]+)"/i, text) ?? captureText(/"X-Codex-Plan-Type":"([^"]+)"/i, text),
    primary,
    secondary,
  };
}

export function pickQuotaWindow(snapshot: QuotaSnapshot | undefined, targetWindowMinutes: number): QuotaWindowSnapshot | undefined {
  const windows = [snapshot?.primary, snapshot?.secondary].filter((value): value is QuotaWindowSnapshot => Boolean(value));
  if (windows.length === 0) {
    return undefined;
  }

  return [...windows].sort(
    (left, right) => Math.abs(left.windowMinutes - targetWindowMinutes) - Math.abs(right.windowMinutes - targetWindowMinutes),
  )[0];
}
