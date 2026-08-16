import { afterEach, describe, expect, it, vi } from "vitest";
import { createSquad, setCurrentUserActor } from "./api";

describe("api request header safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createSquad with a Chinese name sends an ASCII-safe Idempotency-Key instead of crashing", async () => {
    let capturedHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ squad: { id: "squad-1" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }));

    setCurrentUserActor({ type: "user", id: "local-user", name: "本地用户", avatarUrl: null });

    // Regression for MUTI-21: a raw Chinese squad name used to crash the
    // Headers constructor with "Failed to construct 'Headers'" and silently
    // drop the POST. The request must now go through with an encoded value.
    const squad = await createSquad({
      name: "我的文案小组",
      leaderAgentId: "cli-claude",
      memberAgentIds: [],
      skillTags: [],
    });

    expect(squad.id).toBe("squad-1");
    const idempotencyKey = capturedHeaders?.get("Idempotency-Key") ?? "";
    // The header must not contain raw non-ASCII characters and must be
    // made of printable ASCII only (RFC 7230 field-value).
    expect(idempotencyKey).not.toContain("小组");
    expect(idempotencyKey).toMatch(/^[\x21-\x7E]*$/);
    expect(idempotencyKey).toContain("squad-%E6%88%91%E7%9A%84%E6%96%87%E6%A1%88%E5%B0%8F%E7%BB%84");
  });

  it("passes through ordinary ASCII header values unchanged", async () => {
    let capturedHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ squad: { id: "squad-2" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }));

    setCurrentUserActor({ type: "user", id: "local-user", name: "Local User", avatarUrl: null });

    await createSquad({
      name: "Delivery Squad",
      leaderAgentId: "cli-claude",
      memberAgentIds: [],
      skillTags: ["delivery"],
    });

    expect(capturedHeaders?.get("Idempotency-Key")).toBe("squad-Delivery%20Squad-cli-claude");
  });
});
