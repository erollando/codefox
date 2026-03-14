import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "../src/core/capability-registry.js";

describe("CapabilityRegistry", () => {
  it("lists known packs and actions", () => {
    const registry = new CapabilityRegistry();
    const packs = registry.listPacks("active");
    const actions = registry.listActions();
    const runChecks = registry.resolveAction("repo.run_checks");

    expect(packs.map((pack) => pack.pack)).toEqual(["mail", "calendar", "repo", "jira", "ops", "docs"]);
    expect(actions.length).toBeGreaterThan(0);
    expect(registry.isKnownPack("repo")).toBe(true);
    expect(registry.isKnownPack("unknown")).toBe(false);
    expect(runChecks?.action).toBe("run_checks");
    expect(runChecks?.inputSchema.length).toBeGreaterThan(0);
    expect(runChecks?.auditPayloadFields.length).toBeGreaterThan(0);
    expect(registry.resolveAction("repo.unknown")).toBeUndefined();
  });

  it("applies mode runnability rules", () => {
    const registry = new CapabilityRegistry();
    const observePackSummary = registry.listPacks("observe").find((pack) => pack.pack === "repo");
    const activePackSummary = registry.listPacks("active").find((pack) => pack.pack === "repo");

    expect(observePackSummary).toBeDefined();
    expect(activePackSummary).toBeDefined();
    expect((observePackSummary?.runnableInModeCount ?? 0)).toBeLessThan(activePackSummary?.runnableInModeCount ?? 0);
  });
});
