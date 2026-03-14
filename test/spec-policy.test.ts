import { describe, expect, it } from "vitest";
import { SpecPolicyEngine } from "../src/core/spec-policy.js";
import { createInitialWorkflow, getCurrentRevision } from "../src/core/spec-workflow.js";

describe("spec policy engine", () => {
  it("defines mode policies with explicit run-gate and force behavior", () => {
    const policy = new SpecPolicyEngine();

    expect(policy.forMode("observe")).toEqual({
      mode: "observe",
      requireApprovedSpecForRun: false,
      allowForceApproval: true,
      requiredSectionsForApproval: []
    });
    expect(policy.forMode("active")).toEqual({
      mode: "active",
      requireApprovedSpecForRun: true,
      allowForceApproval: false,
      requiredSectionsForApproval: ["CONSTRAINTS", "DONE_WHEN"]
    });
    expect(policy.forMode("full-access")).toEqual({
      mode: "full-access",
      requireApprovedSpecForRun: true,
      allowForceApproval: false,
      requiredSectionsForApproval: ["CONSTRAINTS", "DONE_WHEN"]
    });
  });

  it("computes missing sections per mode", () => {
    const policy = new SpecPolicyEngine();
    const workflow = createInitialWorkflow("prepare release");
    const revision = getCurrentRevision(workflow);
    revision.sections.CONSTRAINTS = [];

    expect(policy.listMissingSectionsForMode(revision, "observe")).toEqual([]);
    expect(policy.listMissingSectionsForMode(revision, "active")).toContain("CONSTRAINTS");
    expect(policy.listMissingSectionsForMode(revision, "full-access")).toContain("CONSTRAINTS");
  });

  it("applies config overrides on top of defaults", () => {
    const policy = new SpecPolicyEngine({
      observe: {
        requireApprovedSpecForRun: true,
        requiredSectionsForApproval: ["REQUEST"]
      },
      active: {
        allowForceApproval: true
      }
    });

    expect(policy.forMode("observe").requireApprovedSpecForRun).toBe(true);
    expect(policy.forMode("observe").requiredSectionsForApproval).toEqual(["REQUEST"]);
    expect(policy.forMode("active").allowForceApproval).toBe(true);
    expect(policy.forMode("full-access").allowForceApproval).toBe(false);
  });
});
