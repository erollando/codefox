import type { CodexReasoningEffort, PolicyMode } from "../types/domain.js";

export type ParsedCommand =
  | { type: "help" }
  | { type: "repos" }
  | { type: "repo"; repoName: string }
  | { type: "repo_add"; repoName: string; repoPath: string }
  | { type: "repo_init"; repoName: string; basePath?: string }
  | { type: "repo_remove"; repoName: string }
  | { type: "repo_info"; repoName?: string }
  | { type: "mode"; mode: PolicyMode }
  | { type: "reasoning"; reasoningEffort?: CodexReasoningEffort }
  | { type: "run"; instruction: string }
  | { type: "steer"; instruction: string }
  | { type: "close" }
  | { type: "status" }
  | { type: "pending" }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "abort" }
  | { type: "unknown"; raw: string };

const MODES: PolicyMode[] = ["observe", "active", "full-access"];
const REASONING_EFFORTS: CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const REASONING_RESET_ARGS = new Set(["default", "reset"]);

function parseWithArg(text: string): [string, string] {
  const trimmed = text.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return [trimmed, ""];
  }
  return [trimmed.slice(0, firstSpace), trimmed.slice(firstSpace + 1).trim()];
}

function normalizeTelegramCommand(commandToken: string): string {
  const atIndex = commandToken.indexOf("@");
  if (atIndex <= 1) {
    return commandToken;
  }
  return commandToken.slice(0, atIndex);
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { type: "unknown", raw: text };
  }

  if (!trimmed.startsWith("/")) {
    return { type: "run", instruction: trimmed };
  }

  const [rawCommand, arg] = parseWithArg(trimmed);
  const command = normalizeTelegramCommand(rawCommand).toLowerCase();

  switch (command) {
    case "/help":
      return { type: "help" };
    case "/repos":
      return { type: "repos" };
    case "/repo":
      if (!arg) {
        return { type: "unknown", raw: text };
      }
      return parseRepoCommand(arg, text);
    case "/mode":
      return MODES.includes(arg as PolicyMode)
        ? { type: "mode", mode: arg as PolicyMode }
        : { type: "unknown", raw: text };
    case "/observe":
      return { type: "mode", mode: "observe" };
    case "/active":
      return { type: "mode", mode: "active" };
    case "/full-access":
      return { type: "mode", mode: "full-access" };
    case "/reasoning":
    case "/effort":
      if (REASONING_RESET_ARGS.has(arg.toLowerCase())) {
        return { type: "reasoning", reasoningEffort: undefined };
      }
      return REASONING_EFFORTS.includes(arg as CodexReasoningEffort)
        ? { type: "reasoning", reasoningEffort: arg as CodexReasoningEffort }
        : { type: "unknown", raw: text };
    case "/run":
      return arg ? { type: "run", instruction: arg } : { type: "unknown", raw: text };
    case "/steer":
      return arg ? { type: "steer", instruction: arg } : { type: "unknown", raw: text };
    case "/close":
      return { type: "close" };
    case "/status":
      return { type: "status" };
    case "/pending":
      return { type: "pending" };
    case "/approve":
      return { type: "approve" };
    case "/deny":
      return { type: "deny" };
    case "/abort":
      return { type: "abort" };
    default:
      return { type: "unknown", raw: text };
  }
}

function parseRepoCommand(arg: string, raw: string): ParsedCommand {
  const [subCommand, ...rest] = arg.split(/\s+/).filter(Boolean);
  const normalized = subCommand?.toLowerCase();

  if (normalized === "add") {
    if (rest.length < 2) {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_add",
      repoName: rest[0],
      repoPath: rest.slice(1).join(" ")
    };
  }

  if (normalized === "init") {
    if (rest.length < 1) {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_init",
      repoName: rest[0],
      basePath: rest.length > 1 ? rest.slice(1).join(" ") : undefined
    };
  }

  if (normalized === "remove") {
    if (rest.length !== 1) {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_remove",
      repoName: rest[0]
    };
  }

  if (normalized === "info") {
    if (rest.length > 1) {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_info",
      repoName: rest[0]
    };
  }

  return { type: "repo", repoName: arg };
}
