import { describe, expect, it } from "vitest";
import {
  approveSpecDraft,
  buildSpecTemplate,
  createSpecDraft,
  listMissingRequiredSections,
  renderSpecDraft
} from "../src/core/spec-workflow.js";

describe("spec workflow", () => {
  it("builds a readable template", () => {
    const template = buildSpecTemplate();
    expect(template).toContain("REQUEST:");
    expect(template).toContain("DONE WHEN:");
  });

  it("creates incrementing drafts and approves them", () => {
    const first = createSpecDraft("add export endpoint");
    const second = createSpecDraft("add retry policy", first.version);

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.status).toBe("draft");

    const approved = approveSpecDraft(first);
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBeDefined();
  });

  it("renders a complete draft with no missing required sections", () => {
    const draft = createSpecDraft("tighten session timeout handling");
    const rendered = renderSpecDraft(draft);
    const missing = listMissingRequiredSections(draft);

    expect(rendered).toContain("SPEC v1 (draft)");
    expect(rendered).toContain("GOAL:");
    expect(rendered).toContain("PLAN:");
    expect(missing).toEqual([]);
  });
});
