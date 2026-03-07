import type { ApprovalRequest, PolicyMode, SessionState, TaskResult } from "../types/domain.js";
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
    "/mode <observe|active>",
    "/ask <question>",
    "/task <instruction>",
    "/status",
    "/pending",
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
  return [`Repo info:`, `name: ${repoName}`, `path: ${rootPath}`].join("\n");
}

export function formatMode(mode: PolicyMode): string {
  return `Mode set to ${mode}.`;
}

export function formatSessionStatus(session: SessionState): string {
  return [
    "Status:",
    `repo: ${session.selectedRepo ?? "(not selected)"}`,
    `mode: ${session.mode}`,
    `active request: ${session.activeRequestId ?? "none"}`
  ].join("\n");
}

export function formatTaskStart(repo: string, mode: PolicyMode, requestId: string): string {
  return `Started request ${requestId}\nrepo: ${repo}\nmode: ${mode}`;
}

export function formatTaskResult(result: TaskResult, repo: string, mode: PolicyMode): string {
  const safeSummary = redactSensitive(result.summary);
  const safeOutputTail = result.outputTail ? redactSensitive(result.outputTail) : undefined;

  const lines = [
    result.ok
      ? "Task completed."
      : result.aborted
        ? "Task aborted."
        : result.timedOut
          ? "Task timed out."
          : "Task failed.",
    `repo: ${repo}`,
    `mode: ${mode}`,
    `summary: ${safeSummary}`
  ];

  if (safeOutputTail) {
    lines.push(`output:\n${safeOutputTail}`);
  }

  return lines.join("\n");
}

export function formatApprovalPending(
  requestId: string,
  repo: string,
  mode: PolicyMode,
  taskType: "ask" | "task",
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
    `task: ${taskType}`,
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
    `task: ${approval.taskType}`,
    `requested by user: ${approval.userId}`,
    `created at: ${approval.createdAt}`,
    `instruction: ${truncateForTelegram(redactSensitive(approval.instruction), 200)}`,
    "Use /approve or /deny."
  ].join("\n");
}

export function formatError(message: string): string {
  return `Error: ${message}`;
}
