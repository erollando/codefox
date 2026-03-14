import { loadConfig, resolveConfigPath } from "./config.js";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "./local-command-queue.js";
import { JsonStateStore, pruneStateByTtl } from "./state-store.js";
import { getCurrentRevision } from "./spec-workflow.js";
import type { PersistedSpecWorkflow } from "./state-store.js";

export interface LocalCliOutput {
  log(line: string): void;
  error(line: string): void;
}

export interface LocalCliParsedArgs {
  command: "help" | "sessions" | "approvals" | "specs" | "session" | "send";
  chatId?: number;
  userId?: number;
  text?: string;
  configPath?: string;
}

export interface LocalCliParseResult {
  ok: boolean;
  args?: LocalCliParsedArgs;
  error?: string;
}

export function parseLocalCliArgs(argv: string[]): LocalCliParseResult {
  let configPath: string | undefined;
  let userId: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--config") {
      const next = argv[index + 1];
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --config."
        };
      }
      configPath = next;
      index += 1;
      continue;
    }
    if (token === "--user") {
      const next = argv[index + 1];
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --user."
        };
      }
      const parsedUserId = Number(next);
      if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0) {
        return {
          ok: false,
          error: "userId must be a positive integer."
        };
      }
      userId = parsedUserId;
      index += 1;
      continue;
    }
    positional.push(token);
  }

  const command = positional[0] ?? "help";

  if (command === "help") {
    return {
      ok: true,
      args: {
        command: "help",
        configPath
      }
    };
  }

  if (command === "sessions" || command === "approvals" || command === "specs") {
    return {
      ok: true,
      args: {
        command,
        configPath
      }
    };
  }

  if (command === "session") {
    const chatIdRaw = positional[1];
    if (!chatIdRaw) {
      return {
        ok: false,
        error: "session command requires <chatId>."
      };
    }
    const chatId = Number(chatIdRaw);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return {
        ok: false,
        error: "chatId must be a positive integer."
      };
    }
    return {
      ok: true,
      args: {
        command: "session",
        chatId,
        configPath
      }
    };
  }

  if (command === "send") {
    const chatIdRaw = positional[1];
    const text = positional.slice(2).join(" ").trim();
    if (!chatIdRaw) {
      return {
        ok: false,
        error: "send command requires <chatId> <command-text>."
      };
    }
    const chatId = Number(chatIdRaw);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return {
        ok: false,
        error: "chatId must be a positive integer."
      };
    }
    if (!text) {
      return {
        ok: false,
        error: "send command requires non-empty <command-text>."
      };
    }
    return {
      ok: true,
      args: {
        command: "send",
        chatId,
        userId,
        text,
        configPath
      }
    };
  }

  return {
    ok: false,
    error: `Unknown command '${command}'.`
  };
}

export async function runLocalCli(argv: string[], output: LocalCliOutput): Promise<number> {
  const parsed = parseLocalCliArgs(argv);
  if (!parsed.ok || !parsed.args) {
    output.error(parsed.error ?? "Invalid arguments.");
    output.log(renderHelp());
    return 1;
  }

  const args = parsed.args;
  if (args.command === "help") {
    output.log(renderHelp());
    return 0;
  }

  const resolvedConfigPath = resolveConfigPath(args.configPath);
  const config = await loadConfig(resolvedConfigPath);

  if (args.command === "send") {
    const effectiveUserId = args.userId ?? config.telegram.allowedUserIds[0];
    if (!effectiveUserId) {
      output.error("No allowed user id configured. Use --user <id> or set telegram.allowedUserIds.");
      return 1;
    }

    const queue = new FileLocalCommandQueue(defaultLocalCommandQueuePath(config.state.filePath));
    const queued = await queue.enqueue({
      chatId: args.chatId as number,
      userId: effectiveUserId,
      text: args.text as string
    });
    output.log(
      `Queued local command ${queued.id} for chat ${queued.chatId} user ${queued.userId}: ${queued.text}`
    );
    output.log(`Queue inbox: ${queue.inboxPath()}`);
    return 0;
  }

  const store = new JsonStateStore(config.state.filePath);
  const loaded = await store.load();
  const pruned = pruneStateByTtl(loaded, {
    sessionTtlHours: config.state.sessionTtlHours,
    approvalTtlHours: config.state.approvalTtlHours
  }).state;

  if (args.command === "sessions") {
    output.log(renderSessions(pruned.sessions));
    return 0;
  }

  if (args.command === "approvals") {
    output.log(renderApprovals(pruned.approvals));
    return 0;
  }

  if (args.command === "specs") {
    output.log(renderSpecs(pruned.specWorkflows));
    return 0;
  }

  const session = pruned.sessions.find((entry) => entry.chatId === args.chatId);
  const approval = pruned.approvals.find((entry) => entry.chatId === args.chatId);
  const spec = pruned.specWorkflows.find((entry) => entry.chatId === args.chatId);

  if (!session) {
    output.error(`No session found for chatId ${args.chatId}.`);
    return 1;
  }

  output.log(renderSessionDetail(session, approval, spec));
  return 0;
}

function renderHelp(): string {
  return [
    "CodeFox local CLI",
    "Usage:",
    "  npm run local:cli -- [--config <path>] sessions",
    "  npm run local:cli -- [--config <path>] approvals",
    "  npm run local:cli -- [--config <path>] specs",
    "  npm run local:cli -- [--config <path>] session <chatId>",
    "  npm run local:cli -- [--config <path>] [--user <id>] send <chatId> <command-text>",
    "  npm run local:cli -- help"
  ].join("\n");
}

function renderSessions(
  sessions: Array<{
    chatId: number;
    selectedRepo?: string;
    mode: string;
    activeRequestId?: string;
    codexThreadId?: string;
    updatedAt: string;
  }>
): string {
  if (sessions.length === 0) {
    return "No active sessions in persisted state.";
  }

  const lines = ["Sessions:"];
  for (const session of sessions) {
    lines.push(
      `- chat=${session.chatId} repo=${session.selectedRepo ?? "(none)"} mode=${session.mode} activeRequest=${session.activeRequestId ?? "none"} thread=${session.codexThreadId ?? "none"} updatedAt=${session.updatedAt}`
    );
  }
  return lines.join("\n");
}

function renderApprovals(
  approvals: Array<{
    id: string;
    chatId: number;
    userId: number;
    repoName: string;
    mode: string;
    capabilityRef?: string;
    createdAt: string;
  }>
): string {
  if (approvals.length === 0) {
    return "No pending approvals in persisted state.";
  }

  const lines = ["Approvals:"];
  for (const approval of approvals) {
    lines.push(
      `- id=${approval.id} chat=${approval.chatId} user=${approval.userId} repo=${approval.repoName} mode=${approval.mode} capability=${approval.capabilityRef ?? "(untyped)"} createdAt=${approval.createdAt}`
    );
  }
  return lines.join("\n");
}

function renderSpecs(
  specWorkflows: PersistedSpecWorkflow[]
): string {
  if (specWorkflows.length === 0) {
    return "No spec workflows in persisted state.";
  }

  const lines = ["Specs:"];
  for (const entry of specWorkflows) {
    const revision = getCurrentRevision(entry.workflow);
    lines.push(
      `- chat=${entry.chatId} version=v${revision.version} stage=${revision.stage} status=${revision.status} updatedAt=${revision.updatedAt}`
    );
  }
  return lines.join("\n");
}

function renderSessionDetail(
  session: {
    chatId: number;
    selectedRepo?: string;
    mode: string;
    activeRequestId?: string;
    codexThreadId?: string;
    codexLastActiveAt?: string;
    updatedAt: string;
  },
  approval?: {
    id: string;
    createdAt: string;
    capabilityRef?: string;
  },
  spec?: PersistedSpecWorkflow
): string {
  const lines = [
    `Session ${session.chatId}:`,
    `repo: ${session.selectedRepo ?? "(none)"}`,
    `mode: ${session.mode}`,
    `active request: ${session.activeRequestId ?? "none"}`,
    `codex thread: ${session.codexThreadId ?? "none"}`,
    `codex last active: ${session.codexLastActiveAt ?? "n/a"}`,
    `updated at: ${session.updatedAt}`
  ];

  if (approval) {
    lines.push(
      `pending approval: ${approval.id} (capability=${approval.capabilityRef ?? "(untyped)"}, createdAt=${approval.createdAt})`
    );
  } else {
    lines.push("pending approval: none");
  }

  if (spec) {
    const revision = getCurrentRevision(spec.workflow);
    lines.push(`current spec: v${revision.version} (${revision.stage}, ${revision.status})`);
  } else {
    lines.push("current spec: none");
  }

  return lines.join("\n");
}
