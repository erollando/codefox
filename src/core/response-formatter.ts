import type { ApprovalRequest, CapabilityPackName, CodexReasoningEffort, PolicyMode, RunKind, SessionState, TaskResult } from "../types/domain.js";
import { redactSensitive } from "./sanitize.js";
import type { SpecModePolicy } from "./spec-policy.js";
import type { InstructionPolicySummary } from "./instruction-policy.js";
import type { CapabilityActionSpec, CapabilityPackSummary } from "./capability-registry.js";
import type { CodexChangelogCheckResult } from "./codex-changelog.js";

const TELEGRAM_OUTPUT_LIMIT = 1200;

function truncateForTelegram(text: string, limit: number = TELEGRAM_OUTPUT_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n... (truncated)`;
}

export function formatHelp(): string {
  return [
    "CodeFox commands:",
    "/help",
    "/repos",
    "/codex-changelog",
    "/capabilities [mail|calendar|repo|jira|ops|docs]",
    "/spec template",
    "/spec draft <intent>",
    "/spec clarify <note>",
    "/spec show",
    "/spec status",
    "/spec diff",
    "/spec approve [force]",
    "/spec clear",
    "/repo <name>",
    "/repo add <name> <absolute-path>",
    "/repo init <name> [base-path]",
    "/repo bootstrap <name> <python|java|nodejs> [base-path]",
    "/repo template <name> <python|java|nodejs>",
    "/repo playbook <name> [overwrite]",
    "/repo guide [name]",
    "/repo remove <name>",
    "/repo info [name]",
    "/mode <observe|active|full-access>",
    "/observe | /active | /full-access",
    "/policy [observe|active|full-access]",
    "/act <pack.action> <instruction>",
    "/reasoning <minimal|low|medium|high|xhigh|default>",
    "/run <instruction>",
    "/steer <instruction>",
    "/close",
    "/service stop [confirm]",
    "/stop [confirm] | /stopconfirm",
    "/status",
    "/details",
    "/handoff <status|show|continue [work-id|index]|clear>",
    "/accept | /reject",
    "/continue [work-id|index]",
    "/resume [work-id|index]",
    "/audit <view_id>",
    "/abort"
  ].join("\n");
}

export function formatPolicySummary(input: {
  currentMode: PolicyMode;
  effectiveMode: PolicyMode;
  requireAgentsForRuns: boolean;
  instructionPolicy: InstructionPolicySummary;
  specPolicies: SpecModePolicy[];
}): string {
  const lines = [
    "Policy:",
    `current mode: ${input.currentMode}`,
    `effective mode: ${input.effectiveMode}`,
    `agents guard required for mutating runs: ${input.requireAgentsForRuns ? "yes" : "no"}`,
    `instruction policy: blockedPatterns=${input.instructionPolicy.blockedPatternCount}, allowedDomains=${input.instructionPolicy.allowedDownloadDomainCount}, forbiddenPathPatterns=${input.instructionPolicy.forbiddenPathPatternCount}`,
    "spec policy by mode:"
  ];

  for (const policy of input.specPolicies) {
    lines.push(
      `- ${policy.mode}: requireApprovedSpecForRun=${policy.requireApprovedSpecForRun ? "yes" : "no"}, allowForceApproval=${policy.allowForceApproval ? "yes" : "no"}, requiredSections=${policy.requiredSectionsForApproval.length > 0 ? policy.requiredSectionsForApproval.join(", ") : "(none)"}`
    );
  }

  return lines.join("\n");
}

export function formatCapabilitiesSummary(input: {
  mode: PolicyMode;
  pack?: CapabilityPackName;
  packs: CapabilityPackSummary[];
  actions: CapabilityActionSpec[];
}): string {
  if (!input.pack) {
    return [
      `Capabilities (mode: ${input.mode}):`,
      ...input.packs.map(
        (pack) =>
          `- ${pack.pack}: actions=${pack.actionCount}, runnable=${pack.runnableInModeCount}, backend=${pack.backendStatus}`
      ),
      "backend: implemented = native backend wired in CodeFox, planned = contract/policy surface not yet native-backed.",
      "Use /capabilities <pack> for action details."
    ].join("\n");
  }

  const packSummary = input.packs.find((entry) => entry.pack === input.pack);
  const backendStatus = packSummary?.backendStatus ?? "planned";
  return [
    `Capabilities pack '${input.pack}' (mode: ${input.mode}, backend: ${backendStatus}):`,
    backendStatus === "implemented"
      ? "backend detail: native backend is wired in CodeFox."
      : "backend detail: policy/contract surface; native backend integration is not wired yet.",
    ...(input.actions.length > 0
      ? input.actions.flatMap((action) => {
          const inputFields =
            action.inputSchema.length > 0
              ? action.inputSchema.map((field) => `${field.name}${field.required ? "*" : ""}:${field.type}`).join(", ")
              : "(none)";
          const auditFields =
            action.auditPayloadFields.length > 0
              ? action.auditPayloadFields.map((field) => field.key).join(", ")
              : "(none)";
          const rollback =
            action.rollbackHints.length > 0 ? action.rollbackHints.join(" | ") : "(none)";
          return [
            `- ${action.action}: risk=${action.riskLevel}, approval=${action.approvalLevel}, context=${action.executionContext}, mutates=${action.mutatesState ? "yes" : "no"}`,
            `  inputs: ${inputFields}`,
            `  audit: ${auditFields}`,
            `  rollback: ${rollback}`
          ];
        })
      : ["- (no actions defined)"])
  ].join("\n");
}

export function formatCodexChangelogCheck(result: CodexChangelogCheckResult): string {
  const lines = [
    "Codex changelog check:",
    `source: ${result.sourceUrl}`,
    `checked at: ${result.checkedAt}`
  ];

  if (result.latestEntry) {
    lines.push(
      `latest entry: ${result.latestEntry.title}${
        result.latestEntry.publishedAt ? ` (${result.latestEntry.publishedAt})` : ""
      }`
    );
  }

  if (result.newEntries.length === 0) {
    lines.push("No new Codex changelog entries since the last recorded baseline.");
    return lines.join("\n");
  }

  lines.push(`new entries: ${result.newEntries.length}`);
  for (const [index, entry] of result.newEntries.slice(0, 3).entries()) {
    lines.push(
      `${index + 1}. ${entry.title}${entry.publishedAt ? ` (${entry.publishedAt})` : ""}`,
      `   decision: ${entry.decision}`,
      `   categories: ${entry.impactHints.map((hint) => hint.category).join(", ")}`,
      `   next: ${entry.impactHints[0]?.suggestedChange ?? "Review manually."}`
    );
  }
  if (result.newEntries.length > 3) {
    lines.push(`... plus ${result.newEntries.length - 3} more new entries.`);
  }

  return lines.join("\n");
}

export function formatRepos(repoNames: string[]): string {
  if (repoNames.length === 0) {
    return "No repositories configured.";
  }

  return `Available repos:\n${repoNames.map((name) => `- ${name}`).join("\n")}`;
}

export function formatRepoInfo(repoName: string, rootPath: string): string {
  return ["Repo info:", `name: ${repoName}`, `path: ${rootPath}`].join("\n");
}

export function formatMode(mode: PolicyMode): string {
  switch (mode) {
    case "observe":
      return "Mode set to observe (read-only sandbox).";
    case "active":
      return "Mode set to active (workspace-write sandbox).";
    case "full-access":
      return "Mode set to full-access (danger-full-access sandbox).";
  }
}

export function formatSessionStatus(
  session: SessionState,
  codexSessionIdleMinutes: number,
  codexDefaultReasoningEffort?: CodexReasoningEffort,
  specModePolicy?: SpecModePolicy
): string {
  const codexSession =
    session.codexThreadId && session.codexLastActiveAt
      ? `${session.codexThreadId} (last active ${session.codexLastActiveAt}, idle timeout ${codexSessionIdleMinutes}m)`
      : "none";
  const effectiveReasoning = session.reasoningEffortOverride ?? codexDefaultReasoningEffort ?? "default";
  const reasoningSource = session.reasoningEffortOverride
    ? "chat override"
    : codexDefaultReasoningEffort
      ? "config default"
      : "no default";
  const lastTokensRemaining = session.lastTokenUsage?.remaining;
  const lines = [
    "Status:",
    `repo: ${session.selectedRepo ?? "(not selected)"}`,
    `mode: ${session.mode}`,
    `reasoning (next run): ${effectiveReasoning} (${reasoningSource})`,
    `active request: ${session.activeRequestId ?? "none"}`,
    `codex session: ${codexSession}`
  ];

  if (typeof lastTokensRemaining === "number") {
    lines.push(`available tokens: ${formatTokenCount(lastTokensRemaining)}`);
    if (session.lastRunAt) {
      lines.push(`available tokens as of: ${session.lastRunAt}`);
    }
  }

  if (specModePolicy) {
    lines.push(`spec policy: mode=${specModePolicy.mode}`);
    lines.push(`spec requires approved for /run: ${specModePolicy.requireApprovedSpecForRun ? "yes" : "no"}`);
    lines.push(`spec force approval: ${specModePolicy.allowForceApproval ? "allowed" : "blocked"}`);
    lines.push(
      `spec required sections for approval: ${
        specModePolicy.requiredSectionsForApproval.length > 0
          ? specModePolicy.requiredSectionsForApproval.join(", ")
          : "(none)"
      }`
    );
  }

  return lines.join("\n");
}

export function formatTaskStart(
  repo: string,
  mode: PolicyMode,
  _requestId: string,
  runKind: RunKind,
  resumed: boolean,
  _resumeThreadId?: string
): string {
  const continuationSuffix = resumed ? " Continuing previous Codex context." : "";
  if (runKind === "steer") {
    return `Applying steer update in ${repo} (${mode}).${continuationSuffix}`;
  }
  return `Working on your request in ${repo} (${mode}).${continuationSuffix}`;
}

export function formatTaskResult(
  result: TaskResult,
  repo: string,
  mode: PolicyMode,
  context?: { instructionPreview?: string }
): string {
  const safeSummary = redactSensitive(result.summary);
  const safeOutputTail = result.outputTail ? redactSensitive(result.outputTail) : undefined;
  const safeInstructionPreview = context?.instructionPreview
    ? redactSensitive(context.instructionPreview).trim()
    : "";

  if (result.ok) {
    return safeSummary;
  }

  const state = result.ok ? "Completed" : result.aborted ? "Aborted" : result.timedOut ? "Timed out" : "Failed";
  const lines = [`${state}: ${safeSummary}`];
  if (safeInstructionPreview) {
    lines.push(`request: ${truncateForTelegram(safeInstructionPreview, 240)}`);
  }

  // Avoid flooding Telegram with Codex banners/transcript on successful runs.
  if (!result.ok && safeOutputTail) {
    lines.push(`output:\n${safeOutputTail}`);
  }

  lines.push("Next: use /details for full context.");
  return lines.join("\n");
}

export function formatApprovalPending(
  requestId: string,
  repo: string,
  mode: PolicyMode,
  instructionPreview: string,
  details: {
    requesterUserId: number;
    createdAt: string;
    capabilityRef?: string;
  }
): string {
  const lines = [
    `Approval required for request ${requestId}.`,
    `repo: ${repo}`,
    `mode: ${mode}`,
    `requested by user: ${details.requesterUserId}`,
    `created at: ${details.createdAt}`,
    `instruction: ${truncateForTelegram(redactSensitive(instructionPreview), 200)}`,
    "Use /approve or /deny."
  ];
  if (details.capabilityRef) {
    lines.splice(5, 0, `capability: ${details.capabilityRef}`);
  }
  return lines.join("\n");
}

export function formatPendingApproval(approval: ApprovalRequest): string {
  const lines = [
    `Pending approval: ${approval.id}`,
    `repo: ${approval.repoName}`,
    `mode: ${approval.mode}`,
    `source: ${approval.source ?? "codefox"}`,
    `requested by user: ${approval.userId}`,
    `created at: ${approval.createdAt}`,
    `instruction: ${truncateForTelegram(redactSensitive(approval.instruction), 200)}`,
    "Use /approve or /deny."
  ];
  if (approval.capabilityRef) {
    lines.splice(6, 0, `capability: ${approval.capabilityRef}`);
  }
  if (approval.externalApproval) {
    lines.push(`external approval key: ${approval.externalApproval.approvalKey}`);
  }
  return lines.join("\n");
}

export function formatError(message: string): string {
  const normalized = message.trim();
  if (!normalized) {
    return "Error";
  }
  if (/^error:/i.test(normalized)) {
    return normalized;
  }
  return `Error: ${normalized}`;
}

export function formatAuditLookup(viewId: string, event?: Record<string, unknown>): string {
  if (!event) {
    return `No audit event found for view id '${viewId}'.`;
  }

  const type = typeof event.type === "string" ? event.type : "(unknown)";
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : "(unknown)";
  const detail = Object.entries(event)
    .filter(([key]) => key !== "type" && key !== "timestamp")
    .slice(0, 8)
    .map(([key, value]) => `${key}=${safeAuditValue(value)}`)
    .join(", ");

  return [
    "Audit event:",
    `view id: ${viewId}`,
    `type: ${type}`,
    `timestamp: ${timestamp}`,
    `details: ${detail || "(none)"}`
  ].join("\n");
}

function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}

function safeAuditValue(value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return String(value);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return truncateForTelegram(JSON.stringify(value), 160);
}
