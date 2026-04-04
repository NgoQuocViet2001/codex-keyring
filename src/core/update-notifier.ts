import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { createInterface } from "node:readline/promises";

const UPDATE_STATE_FILE = "update-notifier.json";
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const UPDATE_DISABLED_VALUES = new Set(["1", "true", "yes"]);

interface UpdateNotifierState {
  lastCheckedAt?: string;
  latestVersion?: string;
  skippedVersion?: string;
  skippedAt?: string;
}

type FetchLike = typeof fetch;

export type UpdatePromptChoice = "update" | "skip" | "continue";

export interface UpdateNotifierOptions {
  packageName: string;
  currentVersion: string;
  storeRoot: string;
  argv?: string[];
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  now?: () => Date;
  fetchImpl?: FetchLike;
  promptChoice?: (context: { currentVersion: string; latestVersion: string }) => Promise<UpdatePromptChoice>;
  installLatest?: (packageName: string, latestVersion: string) => Promise<boolean>;
}

export interface UpdatePromptResult {
  status: "noop" | "continue" | "skip" | "updated";
  latestVersion?: string;
}

function statePath(storeRoot: string): string {
  return path.join(storeRoot, UPDATE_STATE_FILE);
}

function normalizeVersion(value: string): number[] {
  const normalized = value.trim().replace(/^v/iu, "");
  const coreVersion = normalized.split(/[-+]/u)[0] ?? normalized;
  return coreVersion
    .split(".")
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
}

export function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

function isNewerVersion(currentVersion: string, latestVersion: string): boolean {
  return compareVersions(currentVersion, latestVersion) < 0;
}

export function shouldCheckForUpdates(
  argv: string[] = process.argv,
  stdinTTY = Boolean(process.stdin.isTTY),
  stdoutTTY = Boolean(process.stdout.isTTY),
): boolean {
  if (!stdinTTY || !stdoutTTY) {
    return false;
  }

  if (UPDATE_DISABLED_VALUES.has(String(process.env.CODEX_KEYRING_DISABLE_UPDATE_NOTIFIER ?? "").trim().toLowerCase())) {
    return false;
  }

  if (UPDATE_DISABLED_VALUES.has(String(process.env.CI ?? "").trim().toLowerCase())) {
    return false;
  }

  const args = argv.slice(2);
  if (args.length === 0) {
    return false;
  }

  if (
    args.includes("--json") ||
    args.includes("mcp") ||
    args.includes("--help") ||
    args.includes("-h") ||
    args.includes("--version") ||
    args.includes("-V")
  ) {
    return false;
  }

  return true;
}

async function readUpdateState(storeRoot: string): Promise<UpdateNotifierState> {
  try {
    const raw = await readFile(statePath(storeRoot), "utf8");
    return JSON.parse(raw) as UpdateNotifierState;
  } catch {
    return {};
  }
}

async function writeUpdateState(storeRoot: string, state: UpdateNotifierState): Promise<void> {
  await mkdir(storeRoot, { recursive: true });
  await writeFile(statePath(storeRoot), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function fetchLatestVersion(packageName: string, fetchImpl: FetchLike): Promise<string | undefined> {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    headers: {
      accept: "application/json",
    },
    signal: AbortSignal.timeout(1_500),
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as { version?: unknown };
  return typeof payload.version === "string" && payload.version.trim() ? payload.version.trim() : undefined;
}

async function resolveLatestVersion(
  packageName: string,
  storeRoot: string,
  now: Date,
  fetchImpl: FetchLike,
): Promise<{ latestVersion?: string; state: UpdateNotifierState }> {
  const state = await readUpdateState(storeRoot);
  const lastCheckedAtMs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN;
  if (state.latestVersion && !Number.isNaN(lastCheckedAtMs) && now.getTime() - lastCheckedAtMs < CHECK_INTERVAL_MS) {
    return {
      latestVersion: state.latestVersion,
      state,
    };
  }

  try {
    const latestVersion = await fetchLatestVersion(packageName, fetchImpl);
    if (latestVersion) {
      const nextState: UpdateNotifierState = {
        ...state,
        latestVersion,
        lastCheckedAt: now.toISOString(),
      };
      await writeUpdateState(storeRoot, nextState);
      return {
        latestVersion,
        state: nextState,
      };
    }
  } catch {
    // Network failures should never block the caller.
  }

  return {
    latestVersion: state.latestVersion,
    state,
  };
}

async function defaultPromptChoice(context: { currentVersion: string; latestVersion: string }): Promise<UpdatePromptChoice> {
  console.log(`A newer codex-keyring version is available: v${context.latestVersion} (current: v${context.currentVersion}).`);
  console.log("Choose: [U]pdate now, [S]kip this version, or press Enter to continue.");

  const readline = createInterface({ input, output });
  try {
    const answer = (await readline.question("> ")).trim().toLowerCase();
    if (answer === "u" || answer === "update" || answer === "y" || answer === "yes") {
      return "update";
    }
    if (answer === "s" || answer === "skip") {
      return "skip";
    }
    return "continue";
  } finally {
    readline.close();
  }
}

async function defaultInstallLatest(packageName: string, latestVersion: string): Promise<boolean> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";

  return new Promise<boolean>((resolve) => {
    const child = spawn(command, ["install", "-g", `${packageName}@${latestVersion}`], {
      stdio: "inherit",
    });

    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function maybePromptForUpdate(options: UpdateNotifierOptions): Promise<UpdatePromptResult> {
  if (!shouldCheckForUpdates(options.argv, options.stdinTTY, options.stdoutTTY)) {
    return { status: "noop" };
  }

  const now = options.now?.() ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const promptChoice = options.promptChoice ?? defaultPromptChoice;
  const installLatest = options.installLatest ?? defaultInstallLatest;
  const { latestVersion, state } = await resolveLatestVersion(options.packageName, options.storeRoot, now, fetchImpl);
  if (!latestVersion || !isNewerVersion(options.currentVersion, latestVersion)) {
    return { status: "noop" };
  }

  if (state.skippedVersion === latestVersion) {
    return {
      status: "noop",
      latestVersion,
    };
  }

  const choice = await promptChoice({
    currentVersion: options.currentVersion,
    latestVersion,
  });

  if (choice === "skip") {
    const nextState: UpdateNotifierState = {
      ...state,
      latestVersion,
      lastCheckedAt: now.toISOString(),
      skippedVersion: latestVersion,
      skippedAt: now.toISOString(),
    };
    await writeUpdateState(options.storeRoot, nextState);
    return {
      status: "skip",
      latestVersion,
    };
  }

  if (choice === "update") {
    const installed = await installLatest(options.packageName, latestVersion);
    if (installed) {
      const nextState: UpdateNotifierState = {
        ...state,
        latestVersion,
        lastCheckedAt: now.toISOString(),
        skippedVersion: undefined,
        skippedAt: undefined,
      };
      await writeUpdateState(options.storeRoot, nextState);
      console.log(`Updated codex-keyring to v${latestVersion}. Please rerun your command.`);
      return {
        status: "updated",
        latestVersion,
      };
    }

    console.log(`Unable to update automatically. Please run: npm install -g ${options.packageName}@${latestVersion}`);
  }

  return {
    status: "continue",
    latestVersion,
  };
}
