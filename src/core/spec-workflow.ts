export type SpecStatus = "draft" | "approved";

export interface SpecDraft {
  version: number;
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
    QUESTIONS: string[];
    PLAN: string[];
    APPROVALS_REQUIRED: string[];
    DONE_WHEN: string[];
  };
}

const REQUIRED_SECTIONS: Array<keyof SpecDraft["sections"]> = ["REQUEST", "GOAL", "OUTCOME", "PLAN", "DONE_WHEN"];

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

export function createSpecDraft(intent: string, previousVersion = 0, now: Date = new Date()): SpecDraft {
  const request = normalizeSentence(intent);
  const timestamp = now.toISOString();

  return {
    version: previousVersion + 1,
    status: "draft",
    sourceIntent: intent.trim(),
    createdAt: timestamp,
    updatedAt: timestamp,
    sections: {
      REQUEST: request,
      GOAL: `Implement and validate: ${request}`,
      OUTCOME: "Deliver the requested change with verifiable checks and a concise summary of results.",
      CONSTRAINTS: ["Preserve existing behavior unless the request explicitly requires changes."],
      NON_GOALS: ["Do not modify unrelated features or infrastructure."],
      CONTEXT: ["Initial draft generated from remote user intent."],
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
        "Final summary maps results to the request."
      ]
    }
  };
}

export function approveSpecDraft(draft: SpecDraft, now: Date = new Date()): SpecDraft {
  const timestamp = now.toISOString();
  return {
    ...draft,
    status: "approved",
    updatedAt: timestamp,
    approvedAt: timestamp
  };
}

export function listMissingRequiredSections(draft: SpecDraft): string[] {
  return REQUIRED_SECTIONS.filter((sectionName) => {
    const value = draft.sections[sectionName];
    if (Array.isArray(value)) {
      return value.length === 0 || value.every((entry) => entry.trim().length === 0);
    }
    return value.trim().length === 0;
  });
}

export function renderSpecDraft(draft: SpecDraft): string {
  return [
    `SPEC v${draft.version} (${draft.status})`,
    "",
    `REQUEST: ${draft.sections.REQUEST}`,
    "",
    "GOAL:",
    draft.sections.GOAL,
    "",
    "OUTCOME:",
    draft.sections.OUTCOME,
    "",
    "CONSTRAINTS:",
    renderList(draft.sections.CONSTRAINTS),
    "",
    "NON-GOALS:",
    renderList(draft.sections.NON_GOALS),
    "",
    "CONTEXT:",
    renderList(draft.sections.CONTEXT),
    "",
    "QUESTIONS:",
    renderList(draft.sections.QUESTIONS),
    "",
    "PLAN:",
    renderOrderedList(draft.sections.PLAN),
    "",
    "APPROVALS REQUIRED:",
    renderList(draft.sections.APPROVALS_REQUIRED),
    "",
    "DONE WHEN:",
    renderList(draft.sections.DONE_WHEN),
    "",
    `created: ${draft.createdAt}`,
    `updated: ${draft.updatedAt}`,
    draft.approvedAt ? `approved: ${draft.approvedAt}` : ""
  ]
    .filter(Boolean)
    .join("\n");
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
