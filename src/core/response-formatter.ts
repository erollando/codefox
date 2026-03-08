import type { ApprovalRequest, PolicyMode, RunKind, SessionState, TaskResult } from "../types/domain.js";
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

export function formatSessionStatus(session: SessionState, codexSessionIdleMinutes: number): string {
  const codexSession =
    session.codexThreadId && session.codexLastActiveAt
      ? `${session.codexThreadId} (last active ${session.codexLastActiveAt}, idle timeout ${codexSessionIdleMinutes}m)`
      : "none";

  return [
    "Status:",
    `repo: ${session.selectedRepo ?? "(not selected)"}`,
    `mode: ${session.mode}`,
    `reasoning: ${session.reasoningEffortOverride ?? "default"}`,
    `active request: ${session.activeRequestId ?? "none"}`,
    `codex session: ${codexSession}`
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
