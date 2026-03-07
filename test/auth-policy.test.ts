import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/core/auth.js";
import { PolicyEngine } from "../src/core/policy.js";

describe("AccessControl", () => {
  it("allows authorized user and chat", () => {
    const ac = new AccessControl([1, 2], [100]);
    expect(() => ac.assertAuthorized({ userId: 1, chatId: 100 })).not.toThrow();
  });

  it("blocks unauthorized user", () => {
    const ac = new AccessControl([2], [100]);
    expect(() => ac.assertAuthorized({ userId: 1, chatId: 100 })).toThrowError(/Unauthorized userId/);
  });

  it("blocks unauthorized chat when chat allowlist exists", () => {
    const ac = new AccessControl([1], [200]);
    expect(() => ac.assertAuthorized({ userId: 1, chatId: 100 })).toThrowError(/Unauthorized chatId/);
  });
});

describe("PolicyEngine", () => {
  const policy = new PolicyEngine();

  it("allows ask in all modes", () => {
    expect(policy.decide("observe", "ask")).toEqual({ allowed: true, requiresApproval: false });
    expect(policy.decide("active", "ask")).toEqual({ allowed: true, requiresApproval: false });
  });

  it("handles task mode constraints", () => {
    expect(policy.decide("observe", "task")).toEqual({
      allowed: false,
      requiresApproval: false,
      reason: "observe mode blocks mutating tasks"
    });
    expect(policy.decide("active", "task")).toEqual({ allowed: true, requiresApproval: false });
  });
});
