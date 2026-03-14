import type { RunningTask } from "../src/adapters/codex.js";
import type { TelegramUpdate } from "../src/adapters/telegram.js";
import type { TaskContext, TaskResult } from "../src/types/domain.js";
import { ApprovalStore } from "../src/core/approval-store.js";
import { AccessControl } from "../src/core/auth.js";
import { CodeFoxController } from "../src/core/controller.js";
import {
  EXTERNAL_CODEX_SCHEMA_VERSION,
  ExternalCodexIntegration,
  type ExternalCodexHandoffBundle
} from "../src/core/external-codex-integration.js";
import { ExternalCodexRelay } from "../src/core/external-codex-relay.js";
import { buildExternalSessionId } from "../src/core/external-session-route.js";
import { InstructionPolicy } from "../src/core/instruction-policy.js";
import { PolicyEngine } from "../src/core/policy.js";
import { RepoRegistry } from "../src/core/repo-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

interface SentMessage {
  chatId: number;
  text: string;
}

class DemoTelegram {
  readonly sent: SentMessage[] = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

class DemoAudit {
  readonly events: Array<Record<string, unknown>> = [];

  async log(event: Record<string, unknown>): Promise<void> {
    this.events.push(event);
  }
}

class DemoCodex {
  readonly calls: Array<{ repoPath: string; context: TaskContext }> = [];

  startTask(repoPath: string, context: TaskContext): RunningTask {
    this.calls.push({ repoPath, context });
    const result: TaskResult = {
      ok: true,
      summary: `Executed ${context.capability?.ref ?? "run"} for '${context.instruction}'`,
      threadId: `thread_demo_${this.calls.length}`
    };
    return {
      abort: () => {},
      result: Promise.resolve(result)
    };
  }
}

function makeUpdate(text: string, userId = 1, chatId = 100): TelegramUpdate {
  return {
    update_id: Date.now(),
    message: {
      message_id: 1,
      text,
      from: { id: userId },
      chat: { id: chatId }
    }
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function runDemo(): Promise<void> {
  const chatId = 100;
  const userId = 1;
  const repoName = "payments-api";
  const sessionId = buildExternalSessionId(chatId, repoName, "active");

  const telegram = new DemoTelegram();
  const audit = new DemoAudit();
  const approvals = new ApprovalStore();
  const sessions = new SessionManager("observe");
  const codex = new DemoCodex();

  let relay!: ExternalCodexRelay;
  const controller = new CodeFoxController({
    telegram,
    access: new AccessControl([userId], [chatId]),
    repos: new RepoRegistry([{ name: repoName, rootPath: `/tmp/${repoName}` }]),
    sessions,
    policy: new PolicyEngine(),
    approvals,
    audit,
    codex,
    repoInitDefaultParentPath: "/tmp",
    initializeRepo: async () => {},
    requireAgentsForRuns: false,
    instructionPolicy: new InstructionPolicy({
      blockedPatterns: [],
      allowedDownloadDomains: [],
      forbiddenPathPatterns: []
    }),
    codexSessionIdleMinutes: 120,
    externalApprovalDecision: async ({ leaseId, approvalKey, approved, userId: decisionUserId }) => {
      const decided = await relay.decideApproval(leaseId, approvalKey, approved, decisionUserId);
      return Boolean(decided);
    }
  });

  relay = new ExternalCodexRelay({
    integration: new ExternalCodexIntegration(),
    audit,
    notify: async (targetChatId, message) => {
      await telegram.sendMessage(targetChatId, message);
    },
    onApprovalRequested: async (event) => {
      const session = sessions.getOrCreate(event.chatId);
      const selectedRepo = session.selectedRepo;
      if (!selectedRepo) {
        return;
      }
      approvals.set({
        id: `extapr_${event.approvalKey}`,
        chatId: event.chatId,
        userId,
        repoName: selectedRepo,
        mode: session.mode,
        instruction: event.summary,
        capabilityRef: event.requestedCapabilityRef,
        source: "external-codex",
        externalApproval: {
          leaseId: event.leaseId,
          approvalKey: event.approvalKey
        },
        createdAt: new Date().toISOString()
      });
    },
    onHandoffReceived: async (event) => {
      await controller.ingestExternalHandoff(event.chatId, event.leaseId, event.handoff);
    }
  });

  await controller.handleUpdate(makeUpdate(`/repo ${repoName}`));
  await controller.handleUpdate(makeUpdate("/mode active"));
  await controller.handleUpdate(makeUpdate("/spec draft Ship invoice CSV export safely"));
  await controller.handleUpdate(makeUpdate("/spec clarify Keep schema unchanged and add tests"));
  await controller.handleUpdate(makeUpdate("/spec approve"));

  relay.registerRoute({ sessionId, chatId });
  const bind = relay.bind({
    clientId: "vscode-codex-demo",
    session: { sessionId },
    requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
    requestedCapabilityClasses: ["progress", "approval_request", "completion", "handoff_bundle"]
  });
  if (!bind.ok) {
    throw new Error(`Bind failed: ${bind.reasonCode} ${bind.reason}`);
  }

  await relay.relayEvent({
    schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
    leaseId: bind.lease.leaseId,
    eventId: "evt-1",
    clientId: "vscode-codex-demo",
    timestamp: "2026-03-14T15:00:00.000Z",
    sequence: 1,
    type: "progress",
    summary: "Implemented export endpoint and started integration checks",
    progressPercent: 55
  });

  await relay.relayEvent({
    schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
    leaseId: bind.lease.leaseId,
    eventId: "evt-2",
    clientId: "vscode-codex-demo",
    timestamp: "2026-03-14T15:00:08.000Z",
    sequence: 2,
    type: "approval_request",
    summary: "Need approval before preparing release branch",
    approvalKey: "prepare-branch",
    requestedCapabilityRef: "repo.prepare_branch"
  });

  await controller.handleUpdate(makeUpdate("/pending"));
  await controller.handleUpdate(makeUpdate("/approve"));

  await relay.relayEvent({
    schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
    leaseId: bind.lease.leaseId,
    eventId: "evt-3",
    clientId: "vscode-codex-demo",
    timestamp: "2026-03-14T15:00:15.000Z",
    sequence: 3,
    type: "completion",
    status: "success",
    summary: "Execution phase complete in VS Code client"
  });

  const handoff: ExternalCodexHandoffBundle = {
    schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
    leaseId: bind.lease.leaseId,
    handoffId: "handoff-demo-1",
    clientId: "vscode-codex-demo",
    createdAt: "2026-03-14T15:00:20.000Z",
    taskId: "TASK-DEMO-42",
    specRevisionRef: "v2",
    completedWork: ["API endpoint added", "Unit tests updated"],
    remainingWork: [
      {
        id: "rw-1",
        summary: "Run full regression checks before release",
        requestedCapabilityRef: "repo.run_checks"
      }
    ],
    unresolvedRisks: ["Need final green regression suite before branch push"]
  };
  await relay.relayHandoff(handoff);

  await controller.handleUpdate(makeUpdate("/handoff show"));
  await controller.handleUpdate(makeUpdate("/handoff continue rw-1"));
  await flushAsyncWork();

  const approvalRecord = relay.getApprovalDecision(bind.lease.leaseId, "prepare-branch");
  const auditCounts = new Map<string, number>();
  for (const event of audit.events) {
    const type = typeof event.type === "string" ? event.type : "unknown";
    auditCounts.set(type, (auditCounts.get(type) ?? 0) + 1);
  }

  console.log("=== CodeFox Demo: VS Code -> Phone Continuation ===");
  console.log(`session id: ${sessionId}`);
  console.log(`lease id: ${bind.lease.leaseId}`);
  console.log(`approval status: ${approvalRecord?.status ?? "missing"}`);
  console.log(`codex runs executed by CodeFox after handoff: ${codex.calls.length}`);
  console.log("");
  console.log("=== Telegram/CodeFox Interaction Transcript ===");
  telegram.sent.forEach((entry, index) => {
    const line = entry.text.replace(/\n/g, " | ");
    console.log(`${String(index + 1).padStart(2, "0")}. ${line}`);
  });
  console.log("");
  console.log("=== Audit Event Counts (selected) ===");
  const interestingTypes = [
    "external_event_relayed",
    "external_handoff_relayed",
    "external_approval_granted",
    "external_handoff_ingested",
    "external_handoff_continue_requested",
    "codex_start",
    "codex_finish"
  ];
  for (const type of interestingTypes) {
    console.log(`${type}: ${auditCounts.get(type) ?? 0}`);
  }
}

void runDemo().catch((error) => {
  console.error(`Demo failed: ${String(error)}`);
  process.exitCode = 1;
});
