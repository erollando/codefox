import type {
  CapabilityApprovalLevel,
  CapabilityExecutionContext,
  CapabilityInputFieldType,
  CapabilityPackName,
  CapabilityRiskLevel,
  PolicyMode
} from "../types/domain.js";

export interface CapabilityInputFieldSpec {
  name: string;
  type: CapabilityInputFieldType;
  required: boolean;
  description: string;
  enumValues?: string[];
}

export interface CapabilityAuditPayloadField {
  key: string;
  description: string;
}

export interface CapabilityActionSpec {
  pack: CapabilityPackName;
  action: string;
  description: string;
  riskLevel: CapabilityRiskLevel;
  approvalLevel: CapabilityApprovalLevel;
  executionContext: CapabilityExecutionContext;
  mutatesState: boolean;
  inputSchema: CapabilityInputFieldSpec[];
  auditPayloadFields: CapabilityAuditPayloadField[];
  rollbackHints: string[];
}

export interface CapabilityPackSummary {
  pack: CapabilityPackName;
  actionCount: number;
  runnableInModeCount: number;
}

const CAPABILITY_PACKS: CapabilityPackName[] = ["mail", "calendar", "repo", "jira", "ops", "docs"];

function makeAction(spec: {
  pack: CapabilityPackName;
  action: string;
  description: string;
  riskLevel: CapabilityRiskLevel;
  approvalLevel: CapabilityApprovalLevel;
  executionContext: CapabilityExecutionContext;
  mutatesState: boolean;
  inputSchema?: CapabilityInputFieldSpec[];
  auditPayloadFields?: CapabilityAuditPayloadField[];
  rollbackHints?: string[];
}): CapabilityActionSpec {
  return {
    ...spec,
    inputSchema: spec.inputSchema ?? [],
    auditPayloadFields: spec.auditPayloadFields ?? [
      { key: "capabilityRef", description: "Resolved capability action reference." },
      { key: "instructionPreview", description: "Sanitized instruction preview." },
      { key: "resultSummary", description: "Execution result summary." }
    ],
    rollbackHints: spec.rollbackHints ?? []
  };
}

export function toCapabilityRef(action: Pick<CapabilityActionSpec, "pack" | "action">): string {
  return `${action.pack}.${action.action}`;
}

const DEFAULT_CAPABILITY_ACTIONS: CapabilityActionSpec[] = [
  makeAction({
    pack: "mail",
    action: "triage_inbox",
    description: "Classify and summarize incoming emails.",
    riskLevel: "low",
    approvalLevel: "auto-allowed",
    executionContext: "local",
    mutatesState: false,
    inputSchema: [
      { name: "mailbox", type: "string", required: false, description: "Mailbox name or label scope." },
      { name: "lookbackHours", type: "integer", required: false, description: "How far back to inspect recent mail." }
    ]
  }),
  makeAction({
    pack: "mail",
    action: "draft_reply",
    description: "Draft reply suggestions without sending.",
    riskLevel: "low",
    approvalLevel: "approve-once",
    executionContext: "local",
    mutatesState: true,
    inputSchema: [
      { name: "threadId", type: "string", required: true, description: "Mail thread identifier." },
      { name: "tone", type: "enum", required: false, description: "Preferred tone for draft.", enumValues: ["brief", "neutral", "formal"] }
    ],
    rollbackHints: ["Discard draft from outbox/drafts folder if rejected."]
  }),
  makeAction({
    pack: "mail",
    action: "queue_send",
    description: "Queue and send approved outgoing email.",
    riskLevel: "high",
    approvalLevel: "approve-each-write",
    executionContext: "local",
    mutatesState: true,
    inputSchema: [
      { name: "draftId", type: "string", required: true, description: "Approved draft identifier to send." },
      { name: "sendAt", type: "string", required: false, description: "Optional scheduled send time." }
    ],
    rollbackHints: ["If sent, issue correction/follow-up email; if queued, unsend/cancel before delivery."]
  }),
  makeAction({
    pack: "calendar",
    action: "inspect_schedule",
    description: "Read and summarize calendar schedule and conflicts.",
    riskLevel: "low",
    approvalLevel: "auto-allowed",
    executionContext: "either",
    mutatesState: false,
    inputSchema: [
      { name: "windowStart", type: "string", required: false, description: "Start date/time for inspection." },
      { name: "windowEnd", type: "string", required: false, description: "End date/time for inspection." }
    ]
  }),
  makeAction({
    pack: "calendar",
    action: "suggest_changes",
    description: "Propose schedule adjustments within rules.",
    riskLevel: "low",
    approvalLevel: "approve-once",
    executionContext: "either",
    mutatesState: false,
    inputSchema: [
      { name: "changePolicy", type: "string", required: false, description: "Rules for acceptable rescheduling." }
    ]
  }),
  makeAction({
    pack: "calendar",
    action: "apply_changes",
    description: "Apply approved meeting/focus block changes.",
    riskLevel: "medium",
    approvalLevel: "approve-each-write",
    executionContext: "either",
    mutatesState: true,
    inputSchema: [
      { name: "proposalId", type: "string", required: true, description: "Approved proposal identifier." }
    ],
    rollbackHints: ["Revert by restoring the previous calendar event schedule from captured event IDs."]
  }),
  makeAction({
    pack: "repo",
    action: "sync_repo",
    description: "Fetch/remotes sync and branch status collection.",
    riskLevel: "low",
    approvalLevel: "auto-allowed",
    executionContext: "local",
    mutatesState: false,
    inputSchema: [
      { name: "remote", type: "string", required: false, description: "Remote name (defaults to origin)." },
      { name: "branch", type: "string", required: false, description: "Optional branch focus." }
    ]
  }),
  makeAction({
    pack: "repo",
    action: "run_checks",
    description: "Run test/lint/build checks and collect failures.",
    riskLevel: "low",
    approvalLevel: "auto-allowed",
    executionContext: "local",
    mutatesState: false,
    inputSchema: [
      { name: "checkProfile", type: "enum", required: false, description: "Predefined check profile.", enumValues: ["quick", "full", "ci"] }
    ]
  }),
  makeAction({
    pack: "repo",
    action: "prepare_branch",
    description: "Create/update working branch using approved routine.",
    riskLevel: "medium",
    approvalLevel: "approve-once",
    executionContext: "local",
    mutatesState: true,
    inputSchema: [
      { name: "branchName", type: "string", required: true, description: "Target branch name." },
      { name: "baseBranch", type: "string", required: false, description: "Base branch to branch from." }
    ],
    rollbackHints: ["Delete or reset prepared branch if result is rejected."]
  }),
  makeAction({
    pack: "jira",
    action: "read_issues",
    description: "Read and summarize issue/project status.",
    riskLevel: "low",
    approvalLevel: "auto-allowed",
    executionContext: "either",
    mutatesState: false,
    inputSchema: [{ name: "jql", type: "string", required: false, description: "JQL filter for issue selection." }]
  }),
  makeAction({
    pack: "jira",
    action: "draft_updates",
    description: "Draft status updates and subtasks for review.",
    riskLevel: "low",
    approvalLevel: "approve-once",
    executionContext: "either",
    mutatesState: true,
    inputSchema: [
      { name: "issueKey", type: "string", required: true, description: "Primary issue key." },
      { name: "updateType", type: "enum", required: false, description: "Draft update class.", enumValues: ["comment", "subtask", "status"] }
    ],
    rollbackHints: ["Discard draft updates before applying to Jira."]
  }),
  makeAction({
    pack: "jira",
    action: "apply_updates",
    description: "Apply approved issue updates and transitions.",
    riskLevel: "medium",
    approvalLevel: "approve-each-write",
    executionContext: "either",
    mutatesState: true,
    inputSchema: [{ name: "approvedDraftId", type: "string", required: true, description: "Approved draft update identifier." }],
    rollbackHints: ["Post corrective comment/transition if an applied update is incorrect."]
  }),
  makeAction({
    pack: "ops",
    action: "collect_logs",
    description: "Collect predefined logs/artifacts from local machine.",
    riskLevel: "low",
    approvalLevel: "auto-allowed",
    executionContext: "local",
    mutatesState: false,
    inputSchema: [
      { name: "source", type: "enum", required: false, description: "Log source selector.", enumValues: ["build", "runtime", "system"] }
    ]
  }),
  makeAction({
    pack: "ops",
    action: "run_approved_script",
    description: "Run approved script routines with validated inputs.",
    riskLevel: "high",
    approvalLevel: "approve-each-write",
    executionContext: "local",
    mutatesState: true,
    inputSchema: [
      { name: "scriptId", type: "string", required: true, description: "Approved routine/script identifier." },
      { name: "arguments", type: "string", required: false, description: "Validated argument set." }
    ],
    rollbackHints: ["Use script-specific rollback routine or restore snapshot captured before execution."]
  }),
  makeAction({
    pack: "ops",
    action: "local_admin_change",
    description: "High-risk local admin actions requiring local presence.",
    riskLevel: "high",
    approvalLevel: "local-presence-required",
    executionContext: "local",
    mutatesState: true,
    inputSchema: [{ name: "changeRequestId", type: "string", required: true, description: "Tracked change request ID." }],
    rollbackHints: ["Must be accompanied by an explicit local rollback runbook."]
  }),
  makeAction({
    pack: "docs",
    action: "read_docs",
    description: "Read and summarize approved docs/artifacts.",
    riskLevel: "low",
    approvalLevel: "auto-allowed",
    executionContext: "either",
    mutatesState: false,
    inputSchema: [{ name: "scope", type: "path", required: false, description: "Approved doc directory or file pattern." }]
  }),
  makeAction({
    pack: "docs",
    action: "draft_docs_update",
    description: "Draft docs/changelog updates for approval.",
    riskLevel: "low",
    approvalLevel: "approve-once",
    executionContext: "either",
    mutatesState: true,
    inputSchema: [{ name: "targetDoc", type: "path", required: true, description: "Target document path." }],
    rollbackHints: ["Discard draft document changes if not approved."]
  }),
  makeAction({
    pack: "docs",
    action: "apply_docs_update",
    description: "Apply approved updates to project docs.",
    riskLevel: "medium",
    approvalLevel: "approve-each-write",
    executionContext: "either",
    mutatesState: true,
    inputSchema: [{ name: "approvedDraftId", type: "string", required: true, description: "Approved docs draft identifier." }],
    rollbackHints: ["Revert commit/change-set for the docs update if needed."]
  })
];

export class CapabilityRegistry {
  private readonly actions: CapabilityActionSpec[];

  constructor(actions: CapabilityActionSpec[] = DEFAULT_CAPABILITY_ACTIONS) {
    this.actions = [...actions];
  }

  isKnownPack(pack: string): pack is CapabilityPackName {
    return CAPABILITY_PACKS.includes(pack as CapabilityPackName);
  }

  listPacks(mode: PolicyMode): CapabilityPackSummary[] {
    return CAPABILITY_PACKS.map((pack) => {
      const actions = this.listActions(pack);
      return {
        pack,
        actionCount: actions.length,
        runnableInModeCount: actions.filter((action) => this.isActionRunnableInMode(action, mode)).length
      };
    });
  }

  listActions(pack?: CapabilityPackName): CapabilityActionSpec[] {
    const filtered = pack ? this.actions.filter((action) => action.pack === pack) : this.actions;
    return [...filtered].sort((left, right) => {
      if (left.pack === right.pack) {
        return left.action.localeCompare(right.action);
      }
      return left.pack.localeCompare(right.pack);
    });
  }

  resolveAction(ref: string): CapabilityActionSpec | undefined {
    const [rawPack, rawAction] = ref.trim().split(".", 2);
    if (!rawPack || !rawAction) {
      return undefined;
    }
    const pack = rawPack.toLowerCase();
    const action = rawAction.toLowerCase();
    if (!this.isKnownPack(pack)) {
      return undefined;
    }
    return this.actions.find((entry) => entry.pack === pack && entry.action.toLowerCase() === action);
  }

  isActionRunnableInMode(action: CapabilityActionSpec, mode: PolicyMode): boolean {
    if (action.approvalLevel === "prohibited-remotely") {
      return false;
    }

    if (mode === "observe" && action.mutatesState) {
      return false;
    }

    return true;
  }
}
