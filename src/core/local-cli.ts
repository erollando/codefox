import { randomUUID } from "node:crypto";
import { loadConfig, resolveConfigPath } from "./config.js";
import { buildExternalSessionId } from "./external-session-route.js";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "./local-command-queue.js";
import { JsonStateStore, pruneStateByTtl } from "./state-store.js";
import { getCurrentRevision } from "./spec-workflow.js";
import type { PersistedSpecWorkflow } from "./state-store.js";

export interface LocalCliOutput {
  log(line: string): void;
  error(line: string): void;
}

export interface LocalCliParsedArgs {
  command: "help" | "sessions" | "approvals" | "specs" | "session" | "send" | "handoff";
  chatId?: number;
  userId?: number;
  text?: string;
  configPath?: string;
  taskId?: string;
  remainingSummary?: string;
  workId?: string;
  capabilityRef?: string;
  completedWork?: string[];
  unresolvedRisks?: string[];
  unresolvedQuestions?: string[];
  clientId?: string;
  specRevisionRef?: string;
  completionSummary?: string;
  sessionId?: string;
  relayHost?: string;
  relayPort?: number;
  leaseSeconds?: number;
}

interface RelayRoutesResponse {
  ok: boolean;
  routes?: Array<{
    sessionId: string;
    chatId: number;
  }>;
  error?: string;
}

interface RelayBindSuccessResponse {
  ok: true;
  lease: {
    leaseId: string;
    schemaVersion: string;
    session: {
      sessionId: string;
    };
  };
}

interface RelayBindErrorResponse {
  ok: false;
  reasonCode?: string;
  reason?: string;
  error?: string;
}

type RelayBindResponse = RelayBindSuccessResponse | RelayBindErrorResponse;

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

  if (command === "handoff") {
    const handoff = parseHandoffCommand(positional.slice(1));
    if (!handoff.ok || !handoff.args) {
      return {
        ok: false,
        error: handoff.error
      };
    }
    return {
      ok: true,
      args: {
        command: "handoff",
        configPath,
        ...handoff.args
      }
    };
  }

  return {
    ok: false,
    error: `Unknown command '${command}'.`
  };
}

interface HandoffParsedArgs {
  chatId: number;
  taskId: string;
  remainingSummary: string;
  workId?: string;
  capabilityRef?: string;
  completedWork: string[];
  unresolvedRisks: string[];
  unresolvedQuestions: string[];
  clientId?: string;
  specRevisionRef?: string;
  completionSummary?: string;
  sessionId?: string;
  relayHost?: string;
  relayPort?: number;
  leaseSeconds?: number;
}

function parseHandoffCommand(tokens: string[]): { ok: boolean; args?: HandoffParsedArgs; error?: string } {
  const chatIdRaw = tokens[0];
  if (!chatIdRaw) {
    return {
      ok: false,
      error: "handoff command requires <chatId>."
    };
  }
  const chatId = Number(chatIdRaw);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    return {
      ok: false,
      error: "chatId must be a positive integer."
    };
  }

  const completedWork: string[] = [];
  const unresolvedRisks: string[] = [];
  const unresolvedQuestions: string[] = [];
  let taskId: string | undefined;
  let remainingSummary: string | undefined;
  let workId: string | undefined;
  let capabilityRef: string | undefined;
  let clientId: string | undefined;
  let specRevisionRef: string | undefined;
  let completionSummary: string | undefined;
  let sessionId: string | undefined;
  let relayHost: string | undefined;
  let relayPort: number | undefined;
  let leaseSeconds: number | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const readRequired = (flag: string): string | undefined => {
      if (!next) {
        return undefined;
      }
      index += 1;
      return next;
    };

    if (token === "--task") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --task."
        };
      }
      taskId = value;
      continue;
    }
    if (token === "--remaining") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --remaining."
        };
      }
      remainingSummary = value;
      continue;
    }
    if (token === "--work-id") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --work-id."
        };
      }
      workId = value;
      continue;
    }
    if (token === "--capability") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --capability."
        };
      }
      capabilityRef = value;
      continue;
    }
    if (token === "--completed") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --completed."
        };
      }
      completedWork.push(value);
      continue;
    }
    if (token === "--risk") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --risk."
        };
      }
      unresolvedRisks.push(value);
      continue;
    }
    if (token === "--question") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --question."
        };
      }
      unresolvedQuestions.push(value);
      continue;
    }
    if (token === "--client") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --client."
        };
      }
      clientId = value;
      continue;
    }
    if (token === "--spec") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --spec."
        };
      }
      specRevisionRef = value;
      continue;
    }
    if (token === "--completion-summary") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --completion-summary."
        };
      }
      completionSummary = value;
      continue;
    }
    if (token === "--session-id") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --session-id."
        };
      }
      sessionId = value;
      continue;
    }
    if (token === "--host") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --host."
        };
      }
      relayHost = value;
      continue;
    }
    if (token === "--port") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --port."
        };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return {
          ok: false,
          error: "port must be a positive integer."
        };
      }
      relayPort = parsed;
      continue;
    }
    if (token === "--lease-seconds") {
      const value = readRequired(token);
      if (!value) {
        return {
          ok: false,
          error: "Missing value for --lease-seconds."
        };
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return {
          ok: false,
          error: "lease seconds must be a positive integer."
        };
      }
      leaseSeconds = parsed;
      continue;
    }

    return {
      ok: false,
      error: `Unknown handoff option '${token}'.`
    };
  }

  if (!taskId || taskId.trim().length === 0) {
    return {
      ok: false,
      error: "handoff command requires --task <taskId>."
    };
  }
  if (!remainingSummary || remainingSummary.trim().length === 0) {
    return {
      ok: false,
      error: "handoff command requires --remaining <summary>."
    };
  }

  return {
    ok: true,
    args: {
      chatId,
      taskId: taskId.trim(),
      remainingSummary: remainingSummary.trim(),
      workId: workId?.trim(),
      capabilityRef: capabilityRef?.trim(),
      completedWork,
      unresolvedRisks,
      unresolvedQuestions,
      clientId: clientId?.trim(),
      specRevisionRef: specRevisionRef?.trim(),
      completionSummary: completionSummary?.trim(),
      sessionId: sessionId?.trim(),
      relayHost: relayHost?.trim(),
      relayPort,
      leaseSeconds
    }
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

  if (args.command === "handoff") {
    return runLocalHandoff(args, config, output);
  }

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

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

async function runLocalHandoff(args: LocalCliParsedArgs, config: LoadedConfig, output: LocalCliOutput): Promise<number> {
  if (!config.externalRelay.enabled) {
    output.error("externalRelay is disabled in config. Enable externalRelay.enabled to use handoff command.");
    return 1;
  }

  const relayHost = args.relayHost ?? config.externalRelay.host;
  const relayPort = args.relayPort ?? config.externalRelay.port;
  const relayBaseUrl = `http://${relayHost}:${relayPort}`;
  const authToken = config.externalRelay.authTokenEnvVar
    ? process.env[config.externalRelay.authTokenEnvVar]
    : undefined;
  if (config.externalRelay.authTokenEnvVar && !authToken) {
    output.error(
      `Missing required relay token env var '${config.externalRelay.authTokenEnvVar}'.`
    );
    return 1;
  }

  const store = new JsonStateStore(config.state.filePath);
  const loaded = await store.load();
  const pruned = pruneStateByTtl(loaded, {
    sessionTtlHours: config.state.sessionTtlHours,
    approvalTtlHours: config.state.approvalTtlHours
  }).state;

  const chatId = args.chatId as number;
  const sessionId = resolveHandoffSessionId(args, pruned.sessions);
  if (!sessionId.ok || !sessionId.value) {
    output.error(sessionId.error ?? "Could not resolve session id.");
    return 1;
  }

  const specRevisionRef = resolveSpecRevisionRef(args, pruned.specWorkflows);
  if (!specRevisionRef.ok || !specRevisionRef.value) {
    output.error(specRevisionRef.error ?? "Could not resolve spec revision.");
    return 1;
  }

  const routesResponse = await requestRelayJson<RelayRoutesResponse>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/routes",
    method: "GET",
    authToken
  });
  if (!routesResponse.ok || !routesResponse.body?.ok) {
    output.error(renderRelayError("Failed to fetch external relay routes.", routesResponse));
    return 1;
  }
  const routes = routesResponse.body.routes ?? [];
  const matchedRoute = routes.find((route) => route.sessionId === sessionId.value);
  if (!matchedRoute) {
    output.error(
      `Session '${sessionId.value}' is not currently routed. Set /repo and /mode in Telegram first, then retry.`
    );
    return 1;
  }

  const clientId = args.clientId || "codex-handoff-cli";
  const bindResponse = await requestRelayJson<RelayBindResponse>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/bind",
    method: "POST",
    authToken,
    body: {
      clientId,
      session: { sessionId: sessionId.value },
      requestedSchemaVersion: "v1",
      requestedCapabilityClasses: ["completion", "handoff_bundle"],
      ...(typeof args.leaseSeconds === "number" ? { requestedLeaseSeconds: args.leaseSeconds } : {})
    }
  });
  const bindBody = bindResponse.body;
  if (!bindResponse.ok || !bindBody || bindBody.ok !== true) {
    const reason = bindBody && "reason" in bindBody ? bindBody.reason : bindResponse.error;
    output.error(`Bind failed: ${reason ?? "unknown bind error"}.`);
    return 1;
  }

  const leaseId = bindBody.lease.leaseId;
  const schemaVersion = bindBody.lease.schemaVersion;
  const completionEvent = {
    schemaVersion,
    leaseId,
    eventId: `evt_${randomUUID().slice(0, 8)}`,
    clientId,
    timestamp: new Date().toISOString(),
    sequence: 1,
    type: "completion",
    status: "success",
    summary: args.completionSummary || "Execution phase complete in external Codex client"
  };

  const completionResponse = await requestRelayJson<{ decision?: { ok?: boolean; reason?: string } }>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/event",
    method: "POST",
    authToken,
    body: completionEvent
  });
  if (!completionResponse.ok || completionResponse.body?.decision?.ok !== true) {
    await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
    output.error(renderRelayError("Completion event relay failed.", completionResponse));
    return 1;
  }

  const workId = args.workId || "rw-1";
  const handoffId = `handoff_${randomUUID().slice(0, 8)}`;
  const handoffResponse = await requestRelayJson<{ decision?: { ok?: boolean; reason?: string } }>({
    baseUrl: relayBaseUrl,
    path: "/v1/external-codex/handoff",
    method: "POST",
    authToken,
    body: {
      schemaVersion,
      leaseId,
      handoffId,
      clientId,
      createdAt: new Date().toISOString(),
      taskId: args.taskId,
      specRevisionRef: specRevisionRef.value,
      completedWork: args.completedWork ?? [],
      remainingWork: [
        {
          id: workId,
          summary: args.remainingSummary,
          ...(args.capabilityRef ? { requestedCapabilityRef: args.capabilityRef } : {})
        }
      ],
      ...(args.unresolvedQuestions && args.unresolvedQuestions.length > 0
        ? { unresolvedQuestions: args.unresolvedQuestions }
        : {}),
      ...(args.unresolvedRisks && args.unresolvedRisks.length > 0
        ? { unresolvedRisks: args.unresolvedRisks }
        : {})
    }
  });
  if (!handoffResponse.ok || handoffResponse.body?.decision?.ok !== true) {
    await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);
    output.error(renderRelayError("Handoff relay failed.", handoffResponse));
    return 1;
  }

  await bestEffortRevokeLease(relayBaseUrl, authToken, leaseId);

  output.log(`Handoff submitted successfully for chat ${chatId}.`);
  output.log(`session: ${sessionId.value}`);
  output.log(`lease: ${leaseId}`);
  output.log(`handoff id: ${handoffId}`);
  output.log(`task id: ${args.taskId}`);
  output.log(`spec ref: ${specRevisionRef.value}`);
  output.log(`remaining work: ${workId} (${args.remainingSummary})`);
  output.log("Next steps in Telegram:");
  output.log("  /handoff show");
  output.log(`  /handoff continue ${workId}`);
  return 0;
}

function resolveHandoffSessionId(
  args: LocalCliParsedArgs,
  sessions: Array<{
    chatId: number;
    selectedRepo?: string;
    mode: string;
  }>
): { ok: boolean; value?: string; error?: string } {
  if (args.sessionId && args.sessionId.trim().length > 0) {
    return {
      ok: true,
      value: args.sessionId.trim()
    };
  }

  const chatId = args.chatId as number;
  const session = sessions.find((entry) => entry.chatId === chatId);
  if (!session) {
    return {
      ok: false,
      error: `No persisted session found for chatId ${chatId}.`
    };
  }
  if (!session.selectedRepo) {
    return {
      ok: false,
      error: `Session ${chatId} has no selected repo. Set /repo in Telegram first.`
    };
  }
  if (session.mode !== "observe" && session.mode !== "active" && session.mode !== "full-access") {
    return {
      ok: false,
      error: `Session ${chatId} has invalid mode '${session.mode}'.`
    };
  }
  return {
    ok: true,
    value: buildExternalSessionId(chatId, session.selectedRepo, session.mode)
  };
}

function resolveSpecRevisionRef(
  args: LocalCliParsedArgs,
  specWorkflows: PersistedSpecWorkflow[]
): { ok: boolean; value?: string; error?: string } {
  if (args.specRevisionRef && args.specRevisionRef.trim().length > 0) {
    return {
      ok: true,
      value: args.specRevisionRef.trim()
    };
  }

  const chatId = args.chatId as number;
  const spec = specWorkflows.find((entry) => entry.chatId === chatId);
  if (!spec) {
    return {
      ok: false,
      error: `No spec workflow found for chatId ${chatId}. Pass --spec <revision> or create/approve a spec first.`
    };
  }
  const revision = getCurrentRevision(spec.workflow);
  return {
    ok: true,
    value: `v${revision.version}`
  };
}

async function bestEffortRevokeLease(baseUrl: string, authToken: string | undefined, leaseId: string): Promise<void> {
  await requestRelayJson<{ ok?: boolean }>({
    baseUrl,
    path: "/v1/external-codex/revoke",
    method: "POST",
    authToken,
    body: {
      leaseId,
      reason: "handoff submitted"
    }
  });
}

function renderRelayError(message: string, response: JsonRequestResult<unknown>): string {
  const body = response.body;
  const reason =
    body && typeof body === "object" && body !== null
      ? String(
          (body as Record<string, unknown>).reason ??
            (body as Record<string, unknown>).error ??
            (body as Record<string, unknown>).reasonCode ??
            ""
        )
      : "";
  const detail = reason || response.error || "unknown error";
  if (response.status > 0) {
    return `${message} (HTTP ${response.status}) ${detail}`;
  }
  return `${message} ${detail}`;
}

interface JsonRequestResult<T> {
  ok: boolean;
  status: number;
  body?: T;
  error?: string;
}

async function requestRelayJson<T>(options: {
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  authToken?: string;
  body?: unknown;
}): Promise<JsonRequestResult<T>> {
  try {
    const response = await fetch(`${options.baseUrl}${options.path}`, {
      method: options.method,
      headers: {
        ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
        ...(typeof options.body === "undefined" ? {} : { "content-type": "application/json" })
      },
      ...(typeof options.body === "undefined" ? {} : { body: JSON.stringify(options.body) })
    });
    const raw = await response.text();
    let parsed: T | undefined;
    if (raw.trim().length > 0) {
      try {
        parsed = JSON.parse(raw) as T;
      } catch {
        return {
          ok: response.ok,
          status: response.status,
          error: "Response body was not valid JSON."
        };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body: parsed
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: String(error)
    };
  }
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
    "  npm run local:cli -- [--config <path>] handoff <chatId> --task <taskId> --remaining <summary> [options]",
    "    options: [--work-id <id>] [--capability <ref>] [--completed <text>]... [--risk <text>]... [--question <text>]...",
    "             [--client <id>] [--spec <revision>] [--completion-summary <text>] [--session-id <id>]",
    "             [--host <relay-host>] [--port <relay-port>] [--lease-seconds <n>]",
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
    source?: "codefox" | "external-codex";
    externalApproval?: {
      leaseId: string;
      approvalKey: string;
    };
    createdAt: string;
  }>
): string {
  if (approvals.length === 0) {
    return "No pending approvals in persisted state.";
  }

  const lines = ["Approvals:"];
  for (const approval of approvals) {
    const externalRef = approval.externalApproval ? ` externalKey=${approval.externalApproval.approvalKey}` : "";
    lines.push(
      `- id=${approval.id} chat=${approval.chatId} user=${approval.userId} repo=${approval.repoName} mode=${approval.mode} source=${approval.source ?? "codefox"} capability=${approval.capabilityRef ?? "(untyped)"}${externalRef} createdAt=${approval.createdAt}`
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
    source?: "codefox" | "external-codex";
    externalApproval?: {
      leaseId: string;
      approvalKey: string;
    };
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
      `pending approval: ${approval.id} (source=${approval.source ?? "codefox"}, capability=${approval.capabilityRef ?? "(untyped)"}${
        approval.externalApproval ? `, externalKey=${approval.externalApproval.approvalKey}` : ""
      }, createdAt=${approval.createdAt})`
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
