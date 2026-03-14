import { describe, expect, it } from "vitest";
import {
  addClarification,
  approveCurrentRevision,
  buildSpecTemplate,
  createInitialWorkflow,
  getCurrentRevision,
  listMissingSections,
  listMissingRequiredSections,
  renderLatestDiff,
  renderSpecRevision
} from "../src/core/spec-workflow.js";

describe("spec workflow", () => {
  it("builds a readable template", () => {
    const template = buildSpecTemplate();
    expect(template).toContain("REQUEST:");
    expect(template).toContain("ASSUMPTIONS:");
    expect(template).toContain("DONE WHEN:");
  });

  it("creates v0 raw and v1 interpreted revisions", () => {
    const workflow = createInitialWorkflow("add export endpoint");
    const current = getCurrentRevision(workflow);

    expect(workflow.revisions.length).toBe(2);
    expect(workflow.revisions[0]?.version).toBe(0);
    expect(workflow.revisions[0]?.stage).toBe("raw");
    expect(current.version).toBe(1);
    expect(current.stage).toBe("interpreted");
    expect(current.status).toBe("draft");
  });

  it("adds clarification revisions and renders latest diff", () => {
    const workflow = createInitialWorkflow("tighten session timeout handling");
    const clarified = addClarification(workflow, "keep existing repo mapping behavior");
    const current = getCurrentRevision(clarified);
    const diff = renderLatestDiff(clarified);

    expect(current.version).toBe(2);
    expect(current.stage).toBe("clarified");
    expect(current.sections.CONTEXT.some((line) => line.includes("keep existing repo mapping behavior"))).toBe(true);
    expect(diff).toContain("Spec diff: v1 -> v2");
    expect(diff).toContain("+ CONTEXT=Clarification: keep existing repo mapping behavior");
  });

  it("approves the current revision", () => {
    const workflow = createInitialWorkflow("stabilize resume behavior");
    const approvedWorkflow = approveCurrentRevision(workflow);
    const current = getCurrentRevision(approvedWorkflow);

    expect(current.status).toBe("approved");
    expect(current.stage).toBe("approved");
    expect(current.approvedAt).toBeDefined();
  });

  it("renders a complete interpreted revision with no missing required sections", () => {
    const workflow = createInitialWorkflow("add changelog impact check");
    const current = getCurrentRevision(workflow);
    const rendered = renderSpecRevision(current);
    const missing = listMissingRequiredSections(current);

    expect(rendered).toContain("SPEC v1 (interpreted, draft)");
    expect(rendered).toContain("GOAL:");
    expect(rendered).toContain("PLAN:");
    expect(missing).toEqual([]);
  });

  it("supports custom missing-section checks", () => {
    const workflow = createInitialWorkflow("prepare release");
    const current = getCurrentRevision(workflow);
    current.sections.CONSTRAINTS = [];
    const missing = listMissingSections(current, ["CONSTRAINTS"]);
    expect(missing).toEqual(["CONSTRAINTS"]);
  });
});
