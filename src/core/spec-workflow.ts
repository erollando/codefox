import type { SpecSectionName } from "../types/domain.js";

export type SpecStatus = "draft" | "approved";
export type SpecStage = "raw" | "interpreted" | "clarified" | "approved";

export interface SpecRevision {
  version: number;
  stage: SpecStage;
  status: SpecStatus;
  sourceIntent: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  sections: {
    REQUEST: string;
    GOAL: string;
    OUTCOME: string;
    CONSTRAINTS: string[];
    NON_GOALS: string[];
    CONTEXT: string[];
    ASSUMPTIONS: string[];
    QUESTIONS: string[];
    PLAN: string[];
    APPROVALS_REQUIRED: string[];
    DONE_WHEN: string[];
  };
}

export interface SpecWorkflowState {
  revisions: SpecRevision[];
}

const REQUIRED_SECTIONS: SpecSectionName[] = ["REQUEST", "GOAL", "OUTCOME", "PLAN", "DONE_WHEN"];

export function buildSpecTemplate(): string {
  return [
    "REQUEST:",
    "",
    "GOAL:",
    "",
    "OUTCOME:",
    "",
    "CONSTRAINTS:",
    "- ",
    "",
    "NON-GOALS:",
    "- ",
    "",
    "CONTEXT:",
    "- ",
    "",
    "ASSUMPTIONS:",
    "- ",
    "",
    "QUESTIONS:",
    "- ",
    "",
    "PLAN:",
    "1. ",
    "",
    "APPROVALS REQUIRED:",
    "- ",
    "",
    "DONE WHEN:",
    "- "
  ].join("\n");
}

export function createInitialWorkflow(intent: string, now: Date = new Date()): SpecWorkflowState {
  const rawIntent = normalizeSentence(intent);
  const timestamp = now.toISOString();

  const v0Raw: SpecRevision = {
    version: 0,
    stage: "raw",
    status: "draft",
    sourceIntent: rawIntent,
    createdAt: timestamp,
    updatedAt: timestamp,
    sections: {
      REQUEST: rawIntent,
      GOAL: "",
      OUTCOME: "",
      CONSTRAINTS: [],
      NON_GOALS: [],
      CONTEXT: [],
      ASSUMPTIONS: ["Intent may omit constraints and acceptance details."],
      QUESTIONS: ["What constraints and non-goals must be applied?"],
      PLAN: [],
      APPROVALS_REQUIRED: [],
      DONE_WHEN: []
    }
  };

  const v1Interpreted: SpecRevision = {
    version: 1,
    stage: "interpreted",
    status: "draft",
    sourceIntent: rawIntent,
    createdAt: timestamp,
    updatedAt: timestamp,
    sections: {
      REQUEST: rawIntent,
      GOAL: `Implement and validate: ${rawIntent}`,
      OUTCOME: "Deliver the requested change with verifiable checks and a concise result summary.",
      CONSTRAINTS: ["Preserve existing behavior unless explicitly requested otherwise."],
      NON_GOALS: ["Do not modify unrelated features or infrastructure."],
      CONTEXT: ["Structured draft generated from raw intent."],
      ASSUMPTIONS: ["No additional repo-specific constraints provided yet."],
      QUESTIONS: ["Are there repo-specific constraints or approvals to add before execution?"],
      PLAN: [
        "Inspect the affected area and confirm assumptions.",
        "Implement minimal changes required by the request.",
        "Run relevant validation checks.",
        "Summarize results and remaining risks."
      ],
      APPROVALS_REQUIRED: ["Before destructive actions or high-risk external side effects."],
      DONE_WHEN: [
        "The requested change is implemented.",
        "Validation checks complete successfully or failures are explained.",
        "Final summary maps results back to the request."
      ]
    }
  };

  return { revisions: [v0Raw, v1Interpreted] };
}

export function addClarification(
  workflow: SpecWorkflowState,
  clarification: string,
  now: Date = new Date()
): SpecWorkflowState {
  const current = getCurrentRevision(workflow);
  const timestamp = now.toISOString();
  const normalizedClarification = normalizeSentence(clarification);

  const nextRevision: SpecRevision = {
    ...current,
    version: current.version + 1,
    stage: "clarified",
    status: "draft",
    createdAt: timestamp,
    updatedAt: timestamp,
    approvedAt: undefined,
    sections: {
      ...current.sections,
      CONTEXT: [...current.sections.CONTEXT, `Clarification: ${normalizedClarification}`],
      ASSUMPTIONS: current.sections.ASSUMPTIONS.filter(
        (entry) => entry !== "No additional repo-specific constraints provided yet."
      ),
      QUESTIONS: current.sections.QUESTIONS.filter((entry) => entry !== "Are there repo-specific constraints or approvals to add before execution?")
    }
  };

  return {
    revisions: [...workflow.revisions, nextRevision]
  };
}

export function approveCurrentRevision(workflow: SpecWorkflowState, now: Date = new Date()): SpecWorkflowState {
  const current = getCurrentRevision(workflow);
  const timestamp = now.toISOString();

  const approvedRevision: SpecRevision = {
    ...current,
    stage: "approved",
    status: "approved",
    updatedAt: timestamp,
    approvedAt: timestamp
  };

  return {
    revisions: [...workflow.revisions.slice(0, -1), approvedRevision]
  };
}

export function getCurrentRevision(workflow: SpecWorkflowState): SpecRevision {
  return workflow.revisions[workflow.revisions.length - 1]!;
}

export function listMissingRequiredSections(revision: SpecRevision): string[] {
  return listMissingSections(revision, REQUIRED_SECTIONS);
}

export function listMissingSections(revision: SpecRevision, requiredSections: SpecSectionName[]): string[] {
  return requiredSections.filter((sectionName) => isSectionMissing(revision, sectionName));
}

export function renderSpecRevision(revision: SpecRevision): string {
  return [
    `SPEC v${revision.version} (${revision.stage}, ${revision.status})`,
    "",
    `REQUEST: ${revision.sections.REQUEST}`,
    "",
    "GOAL:",
    revision.sections.GOAL,
    "",
    "OUTCOME:",
    revision.sections.OUTCOME,
    "",
    "CONSTRAINTS:",
    renderList(revision.sections.CONSTRAINTS),
    "",
    "NON-GOALS:",
    renderList(revision.sections.NON_GOALS),
    "",
    "CONTEXT:",
    renderList(revision.sections.CONTEXT),
    "",
    "ASSUMPTIONS:",
    renderList(revision.sections.ASSUMPTIONS),
    "",
    "QUESTIONS:",
    renderList(revision.sections.QUESTIONS),
    "",
    "PLAN:",
    renderOrderedList(revision.sections.PLAN),
    "",
    "APPROVALS REQUIRED:",
    renderList(revision.sections.APPROVALS_REQUIRED),
    "",
    "DONE WHEN:",
    renderList(revision.sections.DONE_WHEN),
    "",
    `created: ${revision.createdAt}`,
    `updated: ${revision.updatedAt}`,
    revision.approvedAt ? `approved: ${revision.approvedAt}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderSpecStatus(workflow: SpecWorkflowState): string {
  const current = getCurrentRevision(workflow);
  const versions = workflow.revisions.map((revision) => `v${revision.version}:${revision.stage}`).join(", ");
  const missing = listMissingRequiredSections(current);

  return [
    `Spec status: v${current.version} (${current.stage}, ${current.status})`,
    `revisions: ${versions}`,
    `missing required sections: ${missing.length > 0 ? missing.join(", ") : "(none)"}`,
    `updated: ${current.updatedAt}`
  ].join("\n");
}

export function renderLatestDiff(workflow: SpecWorkflowState): string {
  if (workflow.revisions.length < 2) {
    return "No diff available. At least two revisions are required.";
  }

  const previous = workflow.revisions[workflow.revisions.length - 2]!;
  const current = workflow.revisions[workflow.revisions.length - 1]!;
  const previousLines = revisionToLines(previous);
  const currentLines = revisionToLines(current);

  const added = currentLines.filter((line) => !previousLines.includes(line));
  const removed = previousLines.filter((line) => !currentLines.includes(line));

  return [
    `Spec diff: v${previous.version} -> v${current.version}`,
    added.length > 0 ? "Added:" : "Added: (none)",
    added.length > 0 ? added.map((line) => `+ ${line}`).join("\n") : "",
    removed.length > 0 ? "Removed:" : "Removed: (none)",
    removed.length > 0 ? removed.map((line) => `- ${line}`).join("\n") : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function revisionToLines(revision: SpecRevision): string[] {
  return [
    `REQUEST=${revision.sections.REQUEST}`,
    `GOAL=${revision.sections.GOAL}`,
    `OUTCOME=${revision.sections.OUTCOME}`,
    ...revision.sections.CONSTRAINTS.map((value) => `CONSTRAINTS=${value}`),
    ...revision.sections.NON_GOALS.map((value) => `NON_GOALS=${value}`),
    ...revision.sections.CONTEXT.map((value) => `CONTEXT=${value}`),
    ...revision.sections.ASSUMPTIONS.map((value) => `ASSUMPTIONS=${value}`),
    ...revision.sections.QUESTIONS.map((value) => `QUESTIONS=${value}`),
    ...revision.sections.PLAN.map((value) => `PLAN=${value}`),
    ...revision.sections.APPROVALS_REQUIRED.map((value) => `APPROVALS_REQUIRED=${value}`),
    ...revision.sections.DONE_WHEN.map((value) => `DONE_WHEN=${value}`)
  ];
}

function renderList(values: string[]): string {
  if (values.length === 0) {
    return "- (none)";
  }
  return values.map((value) => `- ${value}`).join("\n");
}

function renderOrderedList(values: string[]): string {
  if (values.length === 0) {
    return "1. (none)";
  }
  return values.map((value, index) => `${index + 1}. ${value}`).join("\n");
}

function normalizeSentence(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return "No request provided.";
  }
  return trimmed;
}

function isSectionMissing(revision: SpecRevision, sectionName: SpecSectionName): boolean {
  const value = revision.sections[sectionName];
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((entry) => entry.trim().length === 0);
  }
  return value.trim().length === 0;
}
