import path from "node:path";

export const isWindows = process.platform === "win32";

export function normalizePath(value: string): string {
  return path.normalize(value);
}

export function displayPath(value: string): string {
  return isWindows ? normalizePath(value) : value;
}

export function toForwardSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}
