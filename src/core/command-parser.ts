import type { AgentTemplateName, CodexReasoningEffort, PolicyMode } from "../types/domain.js";
import type { CapabilityPackName } from "../types/domain.js";

export type ParsedCommand =
  | { type: "help" }
  | { type: "repos" }
  | { type: "capabilities"; pack?: CapabilityPackName }
  | {
      type: "spec";
      action: "template" | "draft" | "clarify" | "show" | "status" | "diff" | "approve" | "clear";
      intent?: string;
      clarification?: string;
      force?: boolean;
    }
  | { type: "repo"; repoName: string }
  | { type: "repo_add"; repoName: string; repoPath: string }
  | { type: "repo_init"; repoName: string; basePath?: string }
  | { type: "repo_bootstrap"; repoName: string; template: AgentTemplateName; basePath?: string }
  | { type: "repo_template"; repoName: string; template: AgentTemplateName }
  | { type: "repo_playbook"; repoName: string; overwrite: boolean }
  | { type: "repo_guide"; repoName?: string }
  | { type: "repo_remove"; repoName: string }
  | { type: "repo_info"; repoName?: string }
  | { type: "mode"; mode: PolicyMode }
  | { type: "policy"; mode?: PolicyMode }
  | { type: "act"; capabilityRef: string; instruction: string }
  | { type: "reasoning"; reasoningEffort?: CodexReasoningEffort }
  | { type: "run"; instruction: string }
  | { type: "steer"; instruction: string }
  | { type: "close" }
  | { type: "status" }
  | { type: "details" }
  | { type: "pending" }
  | { type: "handoff"; action: "status" | "show" | "continue" | "clear"; workId?: string }
  | { type: "approve" }
  | { type: "deny" }
  | { type: "abort" }
  | { type: "audit"; viewId: string }
  | { type: "unknown"; raw: string };

const MODES: PolicyMode[] = ["observe", "active", "full-access"];
const REASONING_EFFORTS: CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const AGENT_TEMPLATES: AgentTemplateName[] = ["python", "java", "nodejs"];
const CAPABILITY_PACKS: CapabilityPackName[] = ["mail", "calendar", "repo", "jira", "ops", "docs"];
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
    case "/capabilities":
      if (!arg) {
        return { type: "capabilities", pack: undefined };
      }
      return CAPABILITY_PACKS.includes(arg as CapabilityPackName)
        ? { type: "capabilities", pack: arg as CapabilityPackName }
        : { type: "unknown", raw: text };
    case "/spec":
      if (!arg) {
        return { type: "unknown", raw: text };
      }
      return parseSpecCommand(arg, text);
    case "/repo":
      if (!arg) {
        return { type: "unknown", raw: text };
      }
      return parseRepoCommand(arg, text);
    case "/mode":
      return MODES.includes(arg as PolicyMode)
        ? { type: "mode", mode: arg as PolicyMode }
        : { type: "unknown", raw: text };
    case "/policy":
      if (!arg) {
        return { type: "policy", mode: undefined };
      }
      return MODES.includes(arg as PolicyMode)
        ? { type: "policy", mode: arg as PolicyMode }
        : { type: "unknown", raw: text };
    case "/act":
      if (!arg) {
        return { type: "unknown", raw: text };
      }
      return parseActCommand(arg, text);
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
    case "/details":
      return { type: "details" };
    case "/pending":
      return { type: "pending" };
    case "/handoff":
      if (!arg) {
        return { type: "handoff", action: "status" };
      }
      return parseHandoffCommand(arg, text);
    case "/approve":
      return { type: "approve" };
    case "/deny":
      return { type: "deny" };
    case "/abort":
      return { type: "abort" };
    case "/audit":
      return arg ? { type: "audit", viewId: arg } : { type: "unknown", raw: text };
    default:
      return { type: "unknown", raw: text };
  }
}

function parseHandoffCommand(arg: string, raw: string): ParsedCommand {
  const parts = arg.split(/\s+/).filter(Boolean);
  const subCommand = parts[0]?.toLowerCase();

  if (subCommand === "status") {
    return parts.length === 1 ? { type: "handoff", action: "status" } : { type: "unknown", raw };
  }
  if (subCommand === "show") {
    return parts.length === 1 ? { type: "handoff", action: "show" } : { type: "unknown", raw };
  }
  if (subCommand === "continue") {
    if (parts.length === 1) {
      return { type: "handoff", action: "continue" };
    }
    if (parts.length === 2) {
      return { type: "handoff", action: "continue", workId: parts[1] };
    }
    return { type: "unknown", raw };
  }
  if (subCommand === "clear") {
    return parts.length === 1 ? { type: "handoff", action: "clear" } : { type: "unknown", raw };
  }

  return { type: "unknown", raw };
}

function parseActCommand(arg: string, raw: string): ParsedCommand {
  const [capabilityRef, ...rest] = arg.split(/\s+/).filter(Boolean);
  if (!capabilityRef || rest.length === 0) {
    return { type: "unknown", raw };
  }
  return {
    type: "act",
    capabilityRef,
    instruction: rest.join(" ")
  };
}

function parseSpecCommand(arg: string, raw: string): ParsedCommand {
  const [subCommand, ...rest] = arg.split(/\s+/).filter(Boolean);
  const normalized = subCommand?.toLowerCase();

  if (normalized === "template") {
    return rest.length === 0 ? { type: "spec", action: "template" } : { type: "unknown", raw };
  }

  if (normalized === "draft") {
    if (rest.length < 1) {
      return { type: "unknown", raw };
    }
    return {
      type: "spec",
      action: "draft",
      intent: rest.join(" ")
    };
  }

  if (normalized === "show") {
    return rest.length === 0 ? { type: "spec", action: "show" } : { type: "unknown", raw };
  }

  if (normalized === "clarify") {
    if (rest.length < 1) {
      return { type: "unknown", raw };
    }
    return {
      type: "spec",
      action: "clarify",
      clarification: rest.join(" ")
    };
  }

  if (normalized === "status") {
    return rest.length === 0 ? { type: "spec", action: "status" } : { type: "unknown", raw };
  }

  if (normalized === "diff") {
    return rest.length === 0 ? { type: "spec", action: "diff" } : { type: "unknown", raw };
  }

  if (normalized === "approve") {
    if (rest.length === 0) {
      return { type: "spec", action: "approve", force: false };
    }
    if (rest.length === 1) {
      const forceArg = rest[0]?.toLowerCase();
      if (forceArg === "force" || forceArg === "--force") {
        return { type: "spec", action: "approve", force: true };
      }
    }
    return { type: "unknown", raw };
  }

  if (normalized === "clear") {
    return rest.length === 0 ? { type: "spec", action: "clear" } : { type: "unknown", raw };
  }

  return { type: "unknown", raw };
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

  if (normalized === "bootstrap") {
    if (rest.length < 2) {
      return { type: "unknown", raw };
    }
    const template = rest[1]?.toLowerCase() as AgentTemplateName;
    if (!AGENT_TEMPLATES.includes(template)) {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_bootstrap",
      repoName: rest[0],
      template,
      basePath: rest.length > 2 ? rest.slice(2).join(" ") : undefined
    };
  }

  if (normalized === "template") {
    if (rest.length !== 2) {
      return { type: "unknown", raw };
    }
    const template = rest[1]?.toLowerCase() as AgentTemplateName;
    if (!AGENT_TEMPLATES.includes(template)) {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_template",
      repoName: rest[0],
      template
    };
  }

  if (normalized === "playbook") {
    if (rest.length < 1 || rest.length > 2) {
      return { type: "unknown", raw };
    }
    const overwriteArg = rest[1]?.toLowerCase();
    if (rest.length === 2 && overwriteArg !== "overwrite" && overwriteArg !== "--overwrite") {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_playbook",
      repoName: rest[0],
      overwrite: rest.length === 2
    };
  }

  if (normalized === "guide") {
    if (rest.length > 1) {
      return { type: "unknown", raw };
    }
    return {
      type: "repo_guide",
      repoName: rest[0]
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
