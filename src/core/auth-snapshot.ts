import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AccountSnapshot, AuthMode, CodexAuthFile } from "./types.js";

export interface AuthIdentity {
  email?: string;
  organization?: string;
  planType?: string;
}

export function normalizeAuthMode(value?: string): AuthMode {
  if (!value) {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "chatgpt") {
    return "chatgpt";
  }
  if (normalized === "api" || normalized === "api_key" || normalized === "apikey") {
    return "api_key";
  }
  return "unknown";
}

export function assertValidAuth(auth: CodexAuthFile): void {
  const hasApiKey = Boolean(auth.OPENAI_API_KEY);
  const hasTokens = Boolean(
    auth.tokens?.access_token || auth.tokens?.refresh_token || auth.tokens?.id_token || auth.tokens?.account_id,
  );

  if (!hasApiKey && !hasTokens) {
    throw new Error("Auth file does not contain an API key or token set.");
  }
}

export async function readAuthFile(authPath: string): Promise<CodexAuthFile> {
  const raw = await readFile(authPath, "utf8");
  const auth = JSON.parse(raw) as CodexAuthFile;
  assertValidAuth(auth);
  return auth;
}

export function fingerprintAuth(auth: CodexAuthFile): string {
  const accountId = auth.tokens?.account_id;
  const authMode = normalizeAuthMode(auth.auth_mode);
  const basis = accountId
    ? `account:${accountId}`
    : auth.OPENAI_API_KEY
      ? `apikey:${auth.OPENAI_API_KEY.length}`
      : `auth:${authMode}`;

  return createHash("sha256").update(basis).digest("hex").slice(0, 12);
}

function decodeJwtClaims(token?: string): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }

  const segments = token.split(".");
  if (segments.length < 2) {
    return undefined;
  }

  try {
    const payload = Buffer.from(segments[1] ?? "", "base64url").toString("utf8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractAuthClaim(claims?: Record<string, unknown>): Record<string, unknown> | undefined {
  const authClaim = claims?.["https://api.openai.com/auth"];
  if (!authClaim || typeof authClaim !== "object") {
    return undefined;
  }
  return authClaim as Record<string, unknown>;
}

function extractOrganizationFromClaims(claims?: Record<string, unknown>): string | undefined {
  const authClaim = extractAuthClaim(claims);
  if (!authClaim) {
    return undefined;
  }

  const directKeys = ["organization", "organization_title", "organization_name", "workspace", "workspace_name", "workspace_title"];
  for (const key of directKeys) {
    const value = Reflect.get(authClaim, key);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const organizations = Reflect.get(authClaim, "organizations");
  if (!Array.isArray(organizations)) {
    return undefined;
  }

  const defaultOrganization =
    organizations.find((organization: unknown) => {
      if (!organization || typeof organization !== "object") {
        return false;
      }
      return Reflect.get(organization, "is_default") === true;
    }) ?? organizations[0];

  if (!defaultOrganization || typeof defaultOrganization !== "object") {
    return undefined;
  }

  const title = Reflect.get(defaultOrganization, "title");
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

function extractPlanTypeFromClaims(claims?: Record<string, unknown>): string | undefined {
  const authClaim = extractAuthClaim(claims);
  if (!authClaim) {
    return undefined;
  }

  const planType = Reflect.get(authClaim, "chatgpt_plan_type");
  return typeof planType === "string" && planType.trim() ? planType.trim() : undefined;
}

export function extractAuthIdentity(auth: CodexAuthFile): AuthIdentity {
  const idTokenClaims = decodeJwtClaims(auth.tokens?.id_token);
  const accessTokenClaims = decodeJwtClaims(auth.tokens?.access_token);

  const email =
    (typeof idTokenClaims?.email === "string" && idTokenClaims.email.trim()) ||
    (typeof accessTokenClaims?.["https://api.openai.com/profile"] === "object" &&
    accessTokenClaims["https://api.openai.com/profile"] !== null &&
    typeof Reflect.get(accessTokenClaims["https://api.openai.com/profile"], "email") === "string"
      ? String(Reflect.get(accessTokenClaims["https://api.openai.com/profile"], "email")).trim()
      : undefined);

  const organization = extractOrganizationFromClaims(idTokenClaims) ?? extractOrganizationFromClaims(accessTokenClaims);
  const planType = extractPlanTypeFromClaims(accessTokenClaims) ?? extractPlanTypeFromClaims(idTokenClaims);

  return {
    email: email || undefined,
    organization,
    planType,
  };
}

export function summarizeAuth(auth: CodexAuthFile): Record<string, unknown> {
  const identity = extractAuthIdentity(auth);
  return {
    authMode: normalizeAuthMode(auth.auth_mode),
    lastRefresh: auth.last_refresh,
    hasApiKey: Boolean(auth.OPENAI_API_KEY),
    tokenFields: Object.keys(auth.tokens ?? {}),
    fingerprint: fingerprintAuth(auth),
    email: identity.email,
    organization: identity.organization,
    planType: identity.planType,
  };
}

export function createSnapshot(auth: CodexAuthFile, source: AccountSnapshot["source"]): AccountSnapshot {
  assertValidAuth(auth);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    source,
    auth,
  };
}

export async function captureSnapshot(authPath: string, source: AccountSnapshot["source"]): Promise<AccountSnapshot> {
  const auth = await readAuthFile(authPath);
  return createSnapshot(auth, source);
}

export async function writeSnapshot(snapshotPath: string, snapshot: AccountSnapshot): Promise<void> {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}
