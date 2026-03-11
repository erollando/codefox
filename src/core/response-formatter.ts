import type { ApprovalRequest, CodexReasoningEffort, PolicyMode, RunKind, SessionState, TaskResult } from "../types/domain.js";
import { redactSensitive } from "./sanitize.js";

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
    "/reasoning <minimal|low|medium|high|xhigh|default>",
    "/run <instruction>",
    "/steer <instruction>",
    "/close",
    "/status",
    "/abort"
  ].join("\n");
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
  codexDefaultReasoningEffort?: CodexReasoningEffort
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
  const lastTokensUsed = session.lastTokenUsage?.total;
  const lastTokensRemaining = session.lastTokenUsage?.remaining;

  return [
    "Status:",
    `repo: ${session.selectedRepo ?? "(not selected)"}`,
    `mode: ${session.mode}`,
    `reasoning (next run): ${effectiveReasoning} (${reasoningSource})`,
    `active request: ${session.activeRequestId ?? "none"}`,
    `codex session: ${codexSession}`,
    `last run: ${session.lastRunAt ?? "none"}`,
    `last reasoning: ${session.lastReasoningEffort ?? "unknown"}`,
    `last tokens used: ${typeof lastTokensUsed === "number" ? formatTokenCount(lastTokensUsed) : "unknown"}`,
    `last tokens remaining: ${typeof lastTokensRemaining === "number" ? formatTokenCount(lastTokensRemaining) : "unavailable"}`
  ].join("\n");
}

export function formatTaskStart(
  repo: string,
  mode: PolicyMode,
  requestId: string,
  runKind: RunKind,
  resumed: boolean
): string {
  return [
    `Started request ${requestId}`,
    `repo: ${repo}`,
    `mode: ${mode}`,
    `type: ${runKind}`,
    `session: ${resumed ? "resumed" : "new"}`
  ].join("\n");
}

export function formatTaskResult(result: TaskResult, repo: string, mode: PolicyMode): string {
  const safeSummary = redactSensitive(result.summary);
  const safeOutputTail = result.outputTail ? redactSensitive(result.outputTail) : undefined;

  const lines = [
    result.ok
      ? "Run completed."
      : result.aborted
        ? "Run aborted."
        : result.timedOut
          ? "Run timed out."
          : "Run failed.",
    `repo: ${repo}`,
    `mode: ${mode}`,
    `summary: ${safeSummary}`
  ];

  if (result.reasoningEffort) {
    lines.push(`reasoning: ${result.reasoningEffort}`);
  }
  if (typeof result.tokenUsage?.total === "number") {
    lines.push(`tokens used: ${formatTokenCount(result.tokenUsage.total)}`);
  }
  if (typeof result.tokenUsage?.remaining === "number") {
    lines.push(`tokens remaining: ${formatTokenCount(result.tokenUsage.remaining)}`);
  }

  if (result.threadId) {
    lines.push(`codex session: ${result.threadId}`);
  }

  // Avoid flooding Telegram with Codex banners/transcript on successful runs.
  if (!result.ok && safeOutputTail) {
    lines.push(`output:\n${safeOutputTail}`);
  }

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
  }
): string {
  return [
    `Approval required for request ${requestId}.`,
    `repo: ${repo}`,
    `mode: ${mode}`,
    `requested by user: ${details.requesterUserId}`,
    `created at: ${details.createdAt}`,
    `instruction: ${truncateForTelegram(redactSensitive(instructionPreview), 200)}`,
    "Use /approve or /deny."
  ].join("\n");
}

export function formatPendingApproval(approval: ApprovalRequest): string {
  return [
    `Pending approval: ${approval.id}`,
    `repo: ${approval.repoName}`,
    `mode: ${approval.mode}`,
    `requested by user: ${approval.userId}`,
    `created at: ${approval.createdAt}`,
    `instruction: ${truncateForTelegram(redactSensitive(approval.instruction), 200)}`,
    "Use /approve or /deny."
  ].join("\n");
}

export function formatError(message: string): string {
  return `Error: ${message}`;
}

function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}
