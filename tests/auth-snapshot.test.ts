import { describe, expect, it } from "vitest";
import { extractAuthIdentity, fingerprintAuth, normalizeAuthMode } from "../src/core/auth-snapshot.js";

describe("auth-snapshot", () => {
  it("normalizes auth modes", () => {
    expect(normalizeAuthMode("ChatGPT")).toBe("chatgpt");
    expect(normalizeAuthMode("api_key")).toBe("api_key");
    expect(normalizeAuthMode("whatever")).toBe("unknown");
  });

  it("builds deterministic fingerprints", () => {
    const first = fingerprintAuth({ auth_mode: "chatgpt", tokens: { account_id: "acct-123" } });
    const second = fingerprintAuth({ auth_mode: "chatgpt", tokens: { account_id: "acct-123" } });
    expect(first).toBe(second);
    expect(first).toHaveLength(12);
  });

  it("extracts email, organization, and plan type from JWT claims", () => {
    const payload = {
      email: "alice@example.com",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "team",
        organizations: [
          {
            title: "Alice Workspace",
            is_default: true,
          },
        ],
      },
    };
    const token = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

    expect(extractAuthIdentity({ auth_mode: "chatgpt", tokens: { id_token: token } })).toEqual({
      email: "alice@example.com",
      organization: "Alice Workspace",
      planType: "team",
    });
  });
});
