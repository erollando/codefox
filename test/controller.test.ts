import { spawnSync } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunningTask } from "../src/adapters/codex.js";
import type { TelegramSendOptions } from "../src/adapters/telegram.js";
import type { ExternalHandoffStateSnapshot, TaskContext, TaskResult } from "../src/types/domain.js";
import type { SpecWorkflowState } from "../src/core/spec-workflow.js";
import type { ExternalCodexHandoffBundle } from "../src/core/external-codex-integration.js";
import { ApprovalStore } from "../src/core/approval-store.js";
import { AccessControl } from "../src/core/auth.js";
import { CodeFoxController } from "../src/core/controller.js";
import { InstructionPolicy } from "../src/core/instruction-policy.js";
import { PolicyEngine } from "../src/core/policy.js";
import { RepoRegistry } from "../src/core/repo-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

interface SentMessage {
  chatId: number;
  text: string;
  options?: TelegramSendOptions;
}

class FakeTelegram {
  readonly sent: SentMessage[] = [];

  async sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<void> {
    this.sent.push({ chatId, text, options });
  }
}

class FakeTelegramWithFiles extends FakeTelegram {
  constructor(
    private readonly files: Record<string, { localPath: string; originalName?: string; mimeType?: string }>
  ) {
    super();
  }

  async downloadFile(fileId: string): Promise<{ localPath: string; originalName?: string; mimeType?: string }> {
    const file = this.files[fileId];
    if (!file) {
      throw new Error(`missing file ${fileId}`);
    }
    return file;
  }
}

class FakeAudit {
  readonly events: Array<Record<string, unknown>> = [];

  async log(event: Record<string, unknown>): Promise<void> {
    this.events.push(event);
  }

  async findByViewId(viewId: string): Promise<Record<string, unknown> | undefined> {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event?.viewId === viewId) {
        return event;
      }
    }
    return undefined;
  }
}

interface FakeCodex {
  calls: Array<{ repoPath: string; context: TaskContext }>;
  startTask: (
    repoPath: string,
    context: TaskContext,
    onProgress?: (line: string) => void | Promise<void>
  ) => RunningTask;
}

function makeUpdate(text: string, userId = 1, chatId = 100) {
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

function makeController(
  fakeCodex: FakeCodex,
  options?: {
    allowedUserIds?: number[];
    defaultMode?: "observe" | "active" | "full-access";
    requireAgentsForRuns?: boolean;
    instructionPolicy?: InstructionPolicy;
    telegram?: FakeTelegram;
    initialSpecWorkflows?: Array<{ chatId: number; workflow: SpecWorkflowState }>;
    initialExternalHandoffs?: ExternalHandoffStateSnapshot[];
    repos?: Array<{ name: string; rootPath: string }>;
    persistState?: () => Promise<void>;
    externalApprovalDecision?: (input: {
      leaseId: string;
      approvalKey: string;
      approved: boolean;
      chatId: number;
      userId: number;
    }) => Promise<boolean>;
  }
) {
  const telegram = options?.telegram ?? new FakeTelegram();
  const audit = new FakeAudit();
  const approvals = new ApprovalStore();
  const sessions = new SessionManager(options?.defaultMode ?? "observe");

  const controller = new CodeFoxController({
    telegram,
    access: new AccessControl(options?.allowedUserIds ?? [1], [100]),
    repos: new RepoRegistry(options?.repos ?? [{ name: "payments-api", rootPath: "/tmp/payments-api" }]),
    sessions,
    policy: new PolicyEngine(),
    approvals,
    audit,
    codex: fakeCodex,
    repoInitDefaultParentPath: "/tmp",
    initializeRepo: async () => {},
    requireAgentsForRuns: Boolean(options?.requireAgentsForRuns),
    instructionPolicy:
      options?.instructionPolicy ??
      new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: [],
        forbiddenPathPatterns: []
      }),
    codexSessionIdleMinutes: 120,
    initialSpecWorkflows: options?.initialSpecWorkflows,
    initialExternalHandoffs: options?.initialExternalHandoffs,
    persistState: options?.persistState,
    externalApprovalDecision: options?.externalApprovalDecision
  });

  return { controller, telegram, audit, approvals, sessions };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CodeFoxController", () => {
  it("rejects unauthorized users", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/help", 2));

    expect(telegram.sent.at(-1)?.text).toBe("Unauthorized.");
    expect(audit.events.length).toBe(0);
  });

  it("auto-selects the only configured repo when running without explicit /repo", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, sessions } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/run check status"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].repoPath).toBe("/tmp/payments-api");
    expect(sessions.getOrCreate(100).selectedRepo).toBe("payments-api");
    expect(
      telegram.sent.some((item) => item.text.includes("Auto-selected repo 'payments-api' (only configured repo)."))
    ).toBe(true);
  });

  it("defaults to most-recent repo context when multiple repos are configured", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, sessions } = makeController(fakeCodex, {
      repos: [
        { name: "payments-api", rootPath: "/tmp/payments-api" },
        { name: "codefox", rootPath: "/tmp/codefox" }
      ]
    });
    sessions.setRepo(200, "codefox");
    sessions.clearRepo(100);

    await controller.handleUpdate(makeUpdate("/run continue remote session"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].repoPath).toBe("/tmp/codefox");
    expect(sessions.getOrCreate(100).selectedRepo).toBe("codefox");
    const selectionMessage = telegram.sent.find((item) =>
      item.text.includes("No repo was selected. Defaulted to 'codefox' from recent context.")
    );
    expect(selectionMessage).toBeDefined();
    expect(selectionMessage?.text).toContain("/repo payments-api");
    expect(selectionMessage?.text).toContain("/repo codefox");
  });

  it("includes effective spec policy in /status output", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/status"));

    const statusMessage = telegram.sent.at(-1)?.text ?? "";
    expect(statusMessage).toContain("Status:");
    expect(statusMessage).toContain("spec policy: mode=active");
    expect(statusMessage).toContain("spec requires approved for /run: yes");
    expect(statusMessage).toContain("spec force approval: blocked");
    expect(statusMessage).toContain("spec required sections for approval: CONSTRAINTS, DONE_WHEN");
    expect(statusMessage).toContain("audit ref: view_");
    const statusEvent = audit.events.find((event) => event.type === "status_viewed");
    expect(statusEvent).toBeDefined();
    expect(String(statusEvent?.viewId ?? "")).toMatch(/^view_[a-f0-9]{8}$/);
  });

  it("returns explicit technical context via /details", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/details"));

    const details = telegram.sent.at(-1)?.text ?? "";
    expect(details).toContain("Status:");
    expect(details).toContain("pending approval: none");
    expect(details).toContain("external handoff: none");
    expect(telegram.sent.at(-1)?.options?.commandButtons).toEqual(["/status", "/handoff show", "/pending"]);
  });

  it("returns full policy summary for /policy and supports mode override", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/policy"));
    await controller.handleUpdate(makeUpdate("/policy full-access"));

    const last = telegram.sent.at(-1)?.text ?? "";
    const previous = telegram.sent.at(-2)?.text ?? "";

    expect(previous).toContain("Policy:");
    expect(previous).toContain("current mode: active");
    expect(previous).toContain("effective mode: active");
    expect(previous).toContain("spec policy by mode:");
    expect(previous).toContain("- observe: requireApprovedSpecForRun=no");
    expect(previous).toContain("- active: requireApprovedSpecForRun=yes");
    expect(last).toContain("effective mode: full-access");
    expect(previous).toContain("audit ref: view_");
    expect(last).toContain("audit ref: view_");
    const policyEvents = audit.events.filter((event) => event.type === "policy_viewed");
    expect(policyEvents).toHaveLength(2);
    expect(policyEvents[0]?.effectiveMode).toBe("active");
    expect(policyEvents[1]?.effectiveMode).toBe("full-access");
    expect(String(policyEvents[0]?.viewId ?? "")).toMatch(/^view_[a-f0-9]{8}$/);
    expect(String(policyEvents[1]?.viewId ?? "")).toMatch(/^view_[a-f0-9]{8}$/);
  });

  it("returns capability pack summaries and details via /capabilities", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/capabilities"));
    await controller.handleUpdate(makeUpdate("/capabilities repo"));

    const overview = telegram.sent.at(-2)?.text ?? "";
    const detail = telegram.sent.at(-1)?.text ?? "";

    expect(overview).toContain("Capabilities (mode: active):");
    expect(overview).toContain("- repo: actions=");
    expect(overview).toContain("backend=planned");
    expect(overview).toContain("backend=implemented");
    expect(overview).toContain("Use /capabilities <pack> for action details.");
    expect(detail).toContain("Capabilities pack 'repo' (mode: active, backend: planned):");
    expect(detail).toContain("backend detail: policy/contract surface");
    expect(detail).toContain("- run_checks:");

    const viewedEvents = audit.events.filter((event) => event.type === "capabilities_viewed");
    expect(viewedEvents).toHaveLength(2);
    expect(viewedEvents[0]?.pack).toBeUndefined();
    expect(viewedEvents[1]?.pack).toBe("repo");
  });

  it("supports /audit lookup for known and unknown view ids", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/status"));
    const statusMessage = telegram.sent.at(-1)?.text ?? "";
    const knownViewId = /audit ref: (view_[a-f0-9]{8})/.exec(statusMessage)?.[1];
    expect(knownViewId).toBeDefined();

    await controller.handleUpdate(makeUpdate(`/audit ${knownViewId}`));
    const found = telegram.sent.at(-1)?.text ?? "";
    expect(found).toContain("Audit event:");
    expect(found).toContain(`view id: ${knownViewId}`);
    expect(found).toContain("type: status_viewed");

    await controller.handleUpdate(makeUpdate("/audit view_00000000"));
    const missing = telegram.sent.at(-1)?.text ?? "";
    expect(missing).toContain("No audit event found for view id 'view_00000000'.");

    const lookups = audit.events.filter((event) => event.type === "audit_view_lookup");
    expect(lookups).toHaveLength(2);
    expect(lookups[0]?.found).toBe(true);
    expect(lookups[1]?.found).toBe(false);
  });

  it("executes /act in active mode with approved spec", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        const result: TaskResult = {
          ok: true,
          summary: "done",
          threadId: "thread_1"
        };
        return { abort: () => {}, result: Promise.resolve(result) };
      }
    };

    const { controller, telegram, approvals, sessions, audit } = makeController(fakeCodex);

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft fix failing test"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks fix failing test"));
    await flushAsyncWork();

    expect(approvals.get(100)).toBeUndefined();
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.runKind).toBe("run");
    expect(fakeCodex.calls[0].context.mode).toBe("active");
    expect(fakeCodex.calls[0].context.capability?.ref).toBe("repo.run_checks");
    expect(telegram.sent.some((item) => item.text.includes("Working on your request in payments-api (active)."))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Completed:"))).toBe(true);
    expect(sessions.getOrCreate(100).codexThreadId).toBe("thread_1");
    expect(
      audit.events.some(
        (event) =>
          event.type === "capability_policy_decision" &&
          event.reasonCode === "auto_allowed" &&
          event.capabilityRef === "repo.run_checks"
      )
    ).toBe(true);
  });

  it("allows untyped /run in active mode", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft fix failing test"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/run fix failing test"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.instruction).toBe("fix failing test");
    expect(fakeCodex.calls[0].context.capability).toBeUndefined();
    expect(
      audit.events.some(
        (event) => event.type === "capability_policy_decision" && event.reasonCode === "legacy_untyped_active"
      )
    ).toBe(true);
  });

  it("blocks unknown capability actions and supports approval-required actions", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, approvals, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft prepare branch workflow"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    await controller.handleUpdate(makeUpdate("/act repo.unknown_action do work"));
    await controller.handleUpdate(makeUpdate("/act repo.prepare_branch prep release branch"));
    await flushAsyncWork();

    expect(telegram.sent.some((item) => item.text.includes("Unknown capability action"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Approval required for request"))).toBe(true);
    expect(approvals.get(100)).toBeDefined();
    expect(approvals.get(100)?.capabilityRef).toBe("repo.prepare_branch");
    expect(fakeCodex.calls.length).toBe(0);
    expect(
      audit.events.some(
        (event) =>
          event.type === "capability_policy_decision" &&
          event.reasonCode === "approve-once" &&
          event.capabilityRef === "repo.prepare_branch"
      )
    ).toBe(true);

    await controller.handleUpdate(makeUpdate("/approve"));
    await flushAsyncWork();
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.capability?.ref).toBe("repo.prepare_branch");
  });

  it("blocks actions that require local presence", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft local admin change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act ops.local_admin_change change firewall settings"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(0);
    expect(telegram.sent.some((item) => item.text.includes("Run blocked by capability policy"))).toBe(true);
    expect(
      audit.events.some(
        (event) => event.type === "capability_policy_block" && event.reasonCode === "local_presence_required"
      )
    ).toBe(true);
  });

  it("resolves external approvals through configured decision sink", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const decisions: Array<Record<string, unknown>> = [];
    const { controller, approvals, telegram, audit } = makeController(fakeCodex, {
      externalApprovalDecision: async (input) => {
        decisions.push(input);
        return true;
      }
    });

    approvals.set({
      id: "extapr_1",
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "approve external push",
      capabilityRef: "repo.prepare_branch",
      source: "external-codex",
      externalApproval: {
        leaseId: "lease_abc",
        approvalKey: "push-branch"
      },
      createdAt: new Date().toISOString()
    });

    await controller.handleUpdate(makeUpdate("/approve"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.approved).toBe(true);
    expect(decisions[0]?.leaseId).toBe("lease_abc");
    expect(approvals.get(100)).toBeUndefined();
    expect(telegram.sent.some((item) => item.text.includes("Approved external request extapr_1"))).toBe(true);
    expect(audit.events.some((event) => event.type === "external_approval_granted")).toBe(true);
  });

  it("revalidates capability ref on /approve and blocks stale unknown actions", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, approvals, audit } = makeController(fakeCodex, { defaultMode: "active" });
    approvals.set({
      id: "req-stale",
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "do something",
      capabilityRef: "repo.unknown_action",
      createdAt: new Date().toISOString()
    });

    await controller.handleUpdate(makeUpdate("/approve"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(0);
    expect(telegram.sent.some((item) => item.text.includes("Unknown capability action 'repo.unknown_action'"))).toBe(true);
    expect(
      audit.events.some(
        (event) => event.type === "capability_policy_block" && event.reasonCode === "unknown_capability_action"
      )
    ).toBe(true);
  });

  it("ingests external handoff and continues remaining work with /handoff continue", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft continue long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_1",
      handoffId: "handoff_1",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-100",
      specRevisionRef: "v1",
      completedWork: ["Implemented API route"],
      remainingWork: [
        {
          id: "rw-1",
          summary: "Run regression checks",
          requestedCapabilityRef: "repo.run_checks"
        }
      ]
    };

    const ingest = await controller.ingestExternalHandoff(100, "lease_1", handoff);
    expect(ingest.accepted).toBe(true);

    await controller.handleUpdate(makeUpdate("/handoff status"));
    await controller.handleUpdate(makeUpdate("/handoff continue"));
    await flushAsyncWork();
    await controller.handleUpdate(makeUpdate("/handoff show"));

    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0]?.context.instruction).toBe("Run regression checks");
    expect(fakeCodex.calls[0]?.context.capability?.ref).toBe("repo.run_checks");
    expect(telegram.sent.some((item) => item.text.includes("Handoff handoff_1"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("rw-1 [continued]"))).toBe(true);
    expect(
      telegram.sent.some((item) => item.options?.commandButtons?.includes("/continue rw-1") === true)
    ).toBe(true);
  });

  it("treats semantically identical external handoff ingest as idempotent", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex, {
      initialExternalHandoffs: [
        {
          chatId: 100,
          leaseId: "lease_existing",
          sourceSessionId: "chat:100/repo:payments-api/mode:active",
          sourceRepoName: "payments-api",
          sourceMode: "active",
          receivedAt: "2026-03-14T12:01:00.000Z",
          continuedWorkIds: ["rw-1"],
          handoff: {
            schemaVersion: "v1",
            leaseId: "lease_existing",
            handoffId: "handoff_existing",
            clientId: "vscode-codex",
            createdAt: "2026-03-14T12:00:00.000Z",
            taskId: "TASK-100",
            specRevisionRef: "v1",
            completedWork: ["B item", "A item"],
            remainingWork: [
              {
                id: "rw-1",
                summary: "Run regression checks",
                requestedCapabilityRef: "repo.run_checks"
              }
            ],
            unresolvedQuestions: ["question-b", "question-a"]
          }
        }
      ],
      initialSpecWorkflows: [
        {
          chatId: 100,
          workflow: {
            revisions: [
              {
                version: 1,
                stage: "approved",
                status: "approved",
                sourceIntent: "continue external work",
                createdAt: "2026-03-14T12:00:00.000Z",
                updatedAt: "2026-03-14T12:00:00.000Z",
                approvedAt: "2026-03-14T12:00:00.000Z",
                sections: {
                  REQUEST: "continue work",
                  GOAL: "goal",
                  OUTCOME: "outcome",
                  CONSTRAINTS: ["constraint"],
                  NON_GOALS: [],
                  CONTEXT: [],
                  ASSUMPTIONS: [],
                  QUESTIONS: [],
                  PLAN: ["plan"],
                  APPROVALS_REQUIRED: [],
                  DONE_WHEN: ["done"]
                }
              }
            ]
          }
        }
      ]
    });

    const duplicateHandoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_new",
      handoffId: "handoff_new",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:05:00.000Z",
      taskId: "TASK-100",
      specRevisionRef: "v1",
      completedWork: ["A item", "B item"],
      remainingWork: [
        {
          id: "rw-1",
          summary: "Run regression checks",
          requestedCapabilityRef: "repo.run_checks"
        }
      ],
      unresolvedQuestions: ["question-a", "question-b"]
    };

    const ingest = await controller.ingestExternalHandoff(
      100,
      "lease_new",
      duplicateHandoff,
      "chat:100/repo:payments-api/mode:active"
    );

    expect(ingest.accepted).toBe(true);
    expect(telegram.sent).toHaveLength(0);

    const handoffs = controller.listExternalHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.leaseId).toBe("lease_existing");
    expect(handoffs[0]?.handoff.handoffId).toBe("handoff_existing");
    expect(handoffs[0]?.continuedWorkIds).toEqual(["rw-1"]);
    expect(
      audit.events.some(
        (event) =>
          event.type === "external_handoff_ingest_duplicate" &&
          event.chatId === 100 &&
          event.handoffId === "handoff_new"
      )
    ).toBe(true);
  });

  it("returns actionable guidance when /continue is requested without a handoff", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/continue"));

    const message = telegram.sent.at(-1)?.text ?? "";
    expect(message).toContain("No external handoff available.");
    expect(message).toContain("npm run handoff:cli");
    expect(telegram.sent.at(-1)?.options?.commandButtons).toEqual(["/status"]);
  });

  it("returns actionable guidance for invalid handoff work id", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft continue long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_invalid_work",
      handoffId: "handoff_invalid_work",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-INVALID-WORK",
      specRevisionRef: "v1",
      completedWork: [],
      remainingWork: [{ id: "rw-1", summary: "Run regression checks" }]
    };
    const ingest = await controller.ingestExternalHandoff(100, "lease_invalid_work", handoff);
    expect(ingest.accepted).toBe(true);

    await controller.handleUpdate(makeUpdate("/continue rw-unknown"));
    const message = telegram.sent.at(-1)?.text ?? "";
    expect(message).toContain("is not available");
    expect(message).toContain("/continue 1");
    expect(message).toContain("Choices:");
  });

  it("supports /continue by numeric index and /resume alias", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft continue long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_multi",
      handoffId: "handoff_multi",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-MULTI",
      specRevisionRef: "v1",
      completedWork: [],
      remainingWork: [
        { id: "rw-1", summary: "Run regression checks" },
        { id: "rw-2", summary: "Prepare release note draft" }
      ]
    };
    const ingest = await controller.ingestExternalHandoff(100, "lease_multi", handoff);
    expect(ingest.accepted).toBe(true);

    await controller.handleUpdate(makeUpdate("/continue 2"));
    await flushAsyncWork();
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0]?.context.instruction).toBe("Prepare release note draft");

    await controller.handleUpdate(makeUpdate("/resume rw-1"));
    await flushAsyncWork();
    expect(fakeCodex.calls.length).toBe(2);
    expect(fakeCodex.calls[1]?.context.instruction).toBe("Run regression checks");
  });

  it("announces default selection when /continue is used with multiple pending items", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft continue long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_multi_default",
      handoffId: "handoff_multi_default",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-MULTI-DEFAULT",
      specRevisionRef: "v1",
      completedWork: [],
      remainingWork: [
        { id: "rw-1", summary: "Run regression checks" },
        { id: "rw-2", summary: "Prepare release note draft" }
      ]
    };
    const ingest = await controller.ingestExternalHandoff(100, "lease_multi_default", handoff);
    expect(ingest.accepted).toBe(true);

    await controller.handleUpdate(makeUpdate("/continue"));
    await flushAsyncWork();
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0]?.context.instruction).toBe("Run regression checks");
    const notice = telegram.sent.find((item) => item.text.includes("Multiple handoff items are pending. Defaulting to 1"));
    expect(notice).toBeDefined();
    expect(notice?.options?.commandButtons).toContain("/continue rw-2");
  });

  it("aligns continuation repo with handoff source session repo", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, sessions } = makeController(fakeCodex, {
      repos: [
        { name: "payments-api", rootPath: "/tmp/payments-api" },
        { name: "billing-api", rootPath: "/tmp/billing-api" }
      ]
    });
    await controller.handleUpdate(makeUpdate("/repo billing-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft continue long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_align",
      handoffId: "handoff_align",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-ALIGN",
      specRevisionRef: "v1",
      completedWork: ["Implemented API route"],
      remainingWork: [{ id: "rw-1", summary: "Run regression checks" }]
    };

    const ingest = await controller.ingestExternalHandoff(
      100,
      "lease_align",
      handoff,
      "chat:100/repo:payments-api/mode:active"
    );
    expect(ingest.accepted).toBe(true);

    await controller.handleUpdate(makeUpdate("/handoff continue"));
    await flushAsyncWork();

    expect(sessions.getOrCreate(100).selectedRepo).toBe("payments-api");
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].repoPath).toBe("/tmp/payments-api");
    expect(telegram.sent.some((item) => item.text.includes("switched to payments-api"))).toBe(true);
  });

  it("auto-registers handoff source repo when metadata includes source path", async () => {
    const handoffRepoDir = await mkdtemp(path.join(os.tmpdir(), "codefox-handoff-repo-"));
    spawnSync("git", ["init"], { cwd: handoffRepoDir, stdio: "ignore" });
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, sessions } = makeController(fakeCodex, {
      repos: [{ name: "billing-api", rootPath: "/tmp/billing-api" }]
    });
    await controller.handleUpdate(makeUpdate("/repo billing-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft continue long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_align_auto_add",
      handoffId: "handoff_align_auto_add",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-ALIGN-AUTO",
      specRevisionRef: "v1",
      completedWork: ["Implemented API route"],
      remainingWork: [{ id: "rw-1", summary: "Run regression checks" }],
      sourceRepo: {
        name: "payments-api",
        rootPath: handoffRepoDir
      }
    };

    const ingest = await controller.ingestExternalHandoff(
      100,
      "lease_align_auto_add",
      handoff,
      "chat:100/repo:payments-api/mode:active"
    );
    expect(ingest.accepted).toBe(true);

    await controller.handleUpdate(makeUpdate("/handoff continue"));
    await flushAsyncWork();

    expect(sessions.getOrCreate(100).selectedRepo).toBe("payments-api");
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].repoPath).toBe(handoffRepoDir);
    expect(telegram.sent.some((item) => item.text.includes("auto-registered"))).toBe(true);
  });

  it("auto-bootstraps missing spec workflow during external handoff ingest", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_bootstrap",
      handoffId: "handoff_bootstrap",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-BOOTSTRAP",
      specRevisionRef: "v1",
      completedWork: ["Implemented API route"],
      remainingWork: [
        {
          id: "rw-1",
          summary: "Run regression checks",
          requestedCapabilityRef: "repo.run_checks"
        }
      ]
    };

    const ingest = await controller.ingestExternalHandoff(100, "lease_bootstrap", handoff);
    expect(ingest.accepted).toBe(true);
    expect(
      audit.events.some(
        (event) =>
          event.type === "external_handoff_spec_bootstrapped" &&
          event.handoffId === "handoff_bootstrap" &&
          event.specRevisionRef === "v1"
      )
    ).toBe(true);

    await controller.handleUpdate(makeUpdate("/spec status"));
    const specStatus = telegram.sent.at(-1)?.text ?? "";
    expect(specStatus).toContain("Spec status: v1 (approved, approved)");
  });

  it("restores persisted external handoff state and renders /handoff status", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex, {
      initialExternalHandoffs: [
        {
          chatId: 100,
          leaseId: "lease_1",
          handoff: {
            schemaVersion: "v1",
            leaseId: "lease_1",
            handoffId: "handoff_1",
            clientId: "vscode-codex",
            createdAt: "2026-03-14T12:00:00.000Z",
            taskId: "TASK-100",
            specRevisionRef: "v1",
            completedWork: ["Implemented API route"],
            remainingWork: [
              {
                id: "rw-1",
                summary: "Run regression checks",
                requestedCapabilityRef: "repo.run_checks"
              }
            ]
          },
          receivedAt: "2026-03-14T12:01:00.000Z",
          continuedWorkIds: []
        }
      ]
    });

    await controller.handleUpdate(makeUpdate("/handoff status"));
    const statusMessage = telegram.sent.at(-1)?.text ?? "";
    expect(statusMessage).toContain("Handoff handoff_1");
    expect(statusMessage).toContain("remaining: 1/1");
  });

  it("rejects external handoff when requested capability is not runnable in current mode", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft continue long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    const handoff: ExternalCodexHandoffBundle = {
      schemaVersion: "v1",
      leaseId: "lease_2",
      handoffId: "handoff_2",
      clientId: "vscode-codex",
      createdAt: "2026-03-14T12:00:00.000Z",
      taskId: "TASK-200",
      specRevisionRef: "v1",
      completedWork: [],
      remainingWork: [
        {
          id: "rw-risk",
          summary: "Run high-risk local admin change",
          requestedCapabilityRef: "ops.local_admin_change"
        }
      ]
    };

    const ingest = await controller.ingestExternalHandoff(100, "lease_2", handoff);
    expect(ingest.accepted).toBe(false);
    expect(ingest.reason).toContain("not runnable in mode active");
  });

  it("allows /run in active mode when no approved spec exists", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/run fix failing test"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
  });

  it("allows /act in active mode when no approved spec exists", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks fix failing test"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
  });

  it("updates per-chat reasoning effort via /reasoning and forwards it to codex", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, sessions } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/reasoning low"));
    await controller.handleUpdate(makeUpdate("/run check status"));
    await flushAsyncWork();

    expect(sessions.getOrCreate(100).reasoningEffortOverride).toBe("low");
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.reasoningEffortOverride).toBe("low");
  });

  it("resets per-chat reasoning effort to config default via /reasoning default", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, sessions } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/reasoning high"));
    await controller.handleUpdate(makeUpdate("/reasoning default"));
    await controller.handleUpdate(makeUpdate("/run check status"));
    await flushAsyncWork();

    expect(sessions.getOrCreate(100).reasoningEffortOverride).toBeUndefined();
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.reasoningEffortOverride).toBeUndefined();
  });

  it("supports spec draft lifecycle while allowing /run before approval", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft add invoice csv export"));
    await controller.handleUpdate(makeUpdate("/run implement export endpoint"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
    expect(telegram.sent.some((item) => item.text.includes("Spec lifecycle initialized."))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("versions: v0(raw), v1(interpreted)"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Use /spec show to review."))).toBe(true);

    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks implement export endpoint"));
    await flushAsyncWork();

    expect(telegram.sent.some((item) => item.text.includes("Spec v1 approved. /run is now allowed."))).toBe(true);
    expect(fakeCodex.calls.length).toBe(2);
  });

  it("supports spec show/status/clear commands", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/spec status"));
    await controller.handleUpdate(makeUpdate("/spec template"));
    await controller.handleUpdate(makeUpdate("/spec draft tighten repo safety checks"));
    await controller.handleUpdate(makeUpdate("/spec clarify keep db schema unchanged"));
    await controller.handleUpdate(makeUpdate("/spec diff"));
    await controller.handleUpdate(makeUpdate("/spec show"));
    await controller.handleUpdate(makeUpdate("/spec status"));
    await controller.handleUpdate(makeUpdate("/spec clear"));
    await controller.handleUpdate(makeUpdate("/spec show"));

    expect(telegram.sent.some((item) => item.text.includes("Spec status: none"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("REQUEST:"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("SPEC v2 (clarified, draft)"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Spec diff: v1 -> v2"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Spec status: v2 (clarified, draft)"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Spec v2 cleared."))).toBe(true);
    expect(telegram.sent.filter((item) => item.text.includes("No spec draft. Use /spec draft")).length).toBe(1);
  });

  it("restores persisted spec workflows while allowing /run execution", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const restoredWorkflow: SpecWorkflowState = {
      revisions: [
        {
          version: 1,
          stage: "interpreted",
          status: "draft",
          sourceIntent: "add invoice export",
          createdAt: "2026-01-01T10:00:00.000Z",
          updatedAt: "2026-01-01T10:00:00.000Z",
          sections: {
            REQUEST: "add invoice export",
            GOAL: "goal",
            OUTCOME: "outcome",
            CONSTRAINTS: [],
            NON_GOALS: [],
            CONTEXT: [],
            ASSUMPTIONS: [],
            QUESTIONS: [],
            PLAN: ["plan"],
            APPROVALS_REQUIRED: [],
            DONE_WHEN: ["done"]
          }
        }
      ]
    };

    const { controller, telegram } = makeController(fakeCodex, {
      initialSpecWorkflows: [{ chatId: 100, workflow: restoredWorkflow }]
    });

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/run implement export"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
    expect(controller.listSpecWorkflows()).toHaveLength(1);
  });

  it("persists state when spec workflow changes", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    let persistCalls = 0;
    const { controller } = makeController(fakeCodex, {
      persistState: async () => {
        persistCalls += 1;
      }
    });

    await controller.handleUpdate(makeUpdate("/spec draft build status dashboard"));
    await controller.handleUpdate(makeUpdate("/spec clarify keep current auth model"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/spec clear"));

    expect(persistCalls).toBe(4);
  });

  it("rejects /spec approve in active mode when mutating-mode sections are missing", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const incompleteWorkflow: SpecWorkflowState = {
      revisions: [
        {
          version: 2,
          stage: "clarified",
          status: "draft",
          sourceIntent: "harden safety policy",
          createdAt: "2026-01-01T10:00:00.000Z",
          updatedAt: "2026-01-01T10:00:00.000Z",
          sections: {
            REQUEST: "harden safety policy",
            GOAL: "goal",
            OUTCOME: "outcome",
            CONSTRAINTS: [],
            NON_GOALS: [],
            CONTEXT: [],
            ASSUMPTIONS: [],
            QUESTIONS: [],
            PLAN: ["plan"],
            APPROVALS_REQUIRED: [],
            DONE_WHEN: ["done"]
          }
        }
      ]
    };

    const { controller, telegram } = makeController(fakeCodex, {
      initialSpecWorkflows: [{ chatId: 100, workflow: incompleteWorkflow }]
    });

    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec approve force"));
    await controller.handleUpdate(makeUpdate("/spec status"));

    expect(
      telegram.sent.some((item) =>
        item.text.includes("missing sections required for mode active (CONSTRAINTS)")
      )
    ).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Spec status: v2 (clarified, draft)"))).toBe(true);
  });

  it("allows /run in active mode even when approved spec misses mutating-mode sections", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const invalidApprovedWorkflow: SpecWorkflowState = {
      revisions: [
        {
          version: 3,
          stage: "approved",
          status: "approved",
          sourceIntent: "prepare release",
          createdAt: "2026-01-01T10:00:00.000Z",
          updatedAt: "2026-01-01T10:00:00.000Z",
          approvedAt: "2026-01-01T10:01:00.000Z",
          sections: {
            REQUEST: "prepare release",
            GOAL: "goal",
            OUTCOME: "outcome",
            CONSTRAINTS: [],
            NON_GOALS: [],
            CONTEXT: [],
            ASSUMPTIONS: [],
            QUESTIONS: [],
            PLAN: ["plan"],
            APPROVALS_REQUIRED: [],
            DONE_WHEN: ["done"]
          }
        }
      ]
    };

    const { controller } = makeController(fakeCodex, {
      initialSpecWorkflows: [{ chatId: 100, workflow: invalidApprovedWorkflow }]
    });

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/run prepare release checklist"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
  });

  it("uses uploaded attachment context for the next run only", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const telegram = new FakeTelegramWithFiles({
      photo_file_1: {
        localPath: "/tmp/codefox-photo-1.jpg",
        originalName: "photo.jpg",
        mimeType: "image/jpeg"
      }
    });
    const { controller } = makeController(fakeCodex, { telegram });

    await controller.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 1 },
        chat: { id: 100 },
        photo: [{ file_id: "photo_file_1", width: 200, height: 200 }]
      }
    });
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/run what is in the uploaded image?"));
    await flushAsyncWork();
    await controller.handleUpdate(makeUpdate("/run repeat without uploading again"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(2);
    expect(fakeCodex.calls[0].context.attachments?.length).toBe(1);
    expect(fakeCodex.calls[0].context.attachments?.[0].kind).toBe("image");
    expect(fakeCodex.calls[0].context.attachments?.[0].localPath).toBe("/tmp/codefox-photo-1.jpg");
    expect(fakeCodex.calls[1].context.attachments ?? []).toHaveLength(0);
  });

  it("allows /run in full-access mode when no approved spec exists", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller } = makeController(fakeCodex, { allowedUserIds: [1, 2] });

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode full-access"));
    await controller.handleUpdate(makeUpdate("/run install dependencies"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
  });

  it("executes /act in full-access mode with approved spec and without codefox pre-run approval", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, approvals } = makeController(fakeCodex, { allowedUserIds: [1, 2] });

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode full-access"));
    await controller.handleUpdate(makeUpdate("/spec draft install dependencies"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks install dependencies"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.mode).toBe("full-access");
    expect(approvals.get(100)).toBeUndefined();
    expect(telegram.sent.some((item) => item.text.includes("Approval required"))).toBe(false);
  });

  it("allows runs in observe mode with read-only intent", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller } = makeController(fakeCodex);

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/run inspect failing tests"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.mode).toBe("observe");
  });

  it("prevents concurrent runs and supports abort", async () => {
    let resolveTask: ((result: TaskResult) => void) | undefined;
    let aborted = false;

    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        const result = new Promise<TaskResult>((resolve) => {
          resolveTask = resolve;
        });

        return {
          abort: () => {
            aborted = true;
            resolveTask?.({
              ok: false,
              summary: "Run aborted by user.",
              aborted: true,
              exitCode: 143
            });
          },
          result
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft long running change"));
    await controller.handleUpdate(makeUpdate("/spec approve"));

    await controller.handleUpdate(makeUpdate("/act repo.run_checks long running change"));
    await flushAsyncWork();

    await controller.handleUpdate(makeUpdate("/act repo.run_checks second request"));
    await flushAsyncWork();

    await controller.handleUpdate(makeUpdate("/abort"));
    await flushAsyncWork();

    expect(aborted).toBe(true);
    expect(fakeCodex.calls.length).toBe(1);
    expect(
      telegram.sent.some(
        (item) =>
          item.text.includes("already running") ||
          item.text.includes("Use /status or /abort") ||
          item.text.includes("Run ") ||
          item.text.includes("send plain text to steer") ||
          item.text.includes("currently being scheduled")
      )
    ).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Abort signal sent"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Aborted:"))).toBe(true);
  });

  it("aborts in-flight runs on controller shutdown", async () => {
    let resolveTask: ((result: TaskResult) => void) | undefined;
    let aborted = false;

    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {
            aborted = true;
            resolveTask?.({
              ok: false,
              summary: "Run aborted by user.",
              aborted: true,
              exitCode: 143
            });
          },
          result: new Promise<TaskResult>((resolve) => {
            resolveTask = resolve;
          })
        };
      }
    };

    const { controller, sessions } = makeController(fakeCodex);

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft long operation"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks long operation"));
    await flushAsyncWork();

    const shutdown = await controller.shutdown();
    await flushAsyncWork();

    expect(aborted).toBe(true);
    expect(shutdown.abortedRequestIds.length).toBe(1);
    expect(shutdown.pendingRequestIds).toEqual([]);
    expect(sessions.getOrCreate(100).activeRequestId).toBeUndefined();
  });

  it("supports /steer by aborting and resuming on the current session", async () => {
    let resolveTask: ((result: TaskResult) => void) | undefined;
    let callCount = 0;

    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        callCount += 1;
        fakeCodex.calls.push({ repoPath, context });
        if (callCount === 1) {
          return {
            abort: () => {
              resolveTask?.({ ok: false, summary: "Run aborted by user.", aborted: true, threadId: "thread_1" });
            },
            result: new Promise<TaskResult>((resolve) => {
              resolveTask = resolve;
            })
          };
        }

        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "continued", threadId: "thread_1" })
        };
      }
    };

    const { controller, telegram } = makeController(fakeCodex);

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft first run"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks first run"));
    await flushAsyncWork();

    await controller.handleUpdate(makeUpdate("/steer focus only on failing test"));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(2);
    expect(fakeCodex.calls[1].context.runKind).toBe("steer");
    expect(fakeCodex.calls[1].context.instruction).toContain("Steer update from the user");
    expect(telegram.sent.some((item) => item.text.includes("Steer received"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Applying 1 steer update"))).toBe(true);
  });

  it("treats plain text as steer while a run is active", async () => {
    let resolveTask: ((result: TaskResult) => void) | undefined;
    let callCount = 0;

    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        callCount += 1;
        fakeCodex.calls.push({ repoPath, context });
        if (callCount === 1) {
          return {
            abort: () => {
              resolveTask?.({ ok: false, summary: "Run aborted by user.", aborted: true, threadId: "thread_1" });
            },
            result: new Promise<TaskResult>((resolve) => {
              resolveTask = resolve;
            })
          };
        }
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "continued", threadId: "thread_1" })
        };
      }
    };

    const { controller } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft first run"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks first run"));
    await flushAsyncWork();

    await controller.handleUpdate(makeUpdate("what was the last question?"));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(2);
    expect(fakeCodex.calls[1].context.runKind).toBe("steer");
    expect(fakeCodex.calls[1].context.instruction).toContain("what was the last question?");
  });

  it("queues plain-text follow-up while admission lock is active", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "done" })
        };
      }
    };

    const { controller, telegram, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));

    const internals = controller as unknown as {
      executionAdmissionLock: Set<number>;
      executionAdmissionSource: Map<number, string>;
    };
    internals.executionAdmissionLock.add(100);
    internals.executionAdmissionSource.set(100, "run");

    await controller.handleUpdate(makeUpdate("what was the last question?"));

    expect(fakeCodex.calls.length).toBe(0);
    expect(telegram.sent.some((item) => item.text.includes("Queued follow-up (1) while run request is being prepared"))).toBe(
      true
    );
    expect(audit.events.some((event) => event.type === "steer_queued_waiting_admission")).toBe(true);
  });

  it("blocks repo switching while a request is running", async () => {
    let resolveTask: ((result: TaskResult) => void) | undefined;
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {
            resolveTask?.({ ok: false, summary: "Run aborted by user.", aborted: true });
          },
          result: new Promise<TaskResult>((resolve) => {
            resolveTask = resolve;
          })
        };
      }
    };

    const telegram = new FakeTelegram();
    const sessions = new SessionManager("active");
    const controller = new CodeFoxController({
      telegram,
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([
        { name: "payments-api", rootPath: "/tmp/payments-api" },
        { name: "codefox", rootPath: "/tmp/codefox" }
      ]),
      sessions,
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit: new FakeAudit(),
      codex: fakeCodex,
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForRuns: false,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
      codexSessionIdleMinutes: 120
    });

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/spec draft long operation"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks long operation"));
    await flushAsyncWork();

    await controller.handleUpdate(makeUpdate("/repo codefox"));

    expect(sessions.getOrCreate(100).selectedRepo).toBe("payments-api");
    expect(
      telegram.sent.some(
        (item) =>
          item.text.includes("Abort it first with /abort") ||
          item.text.includes("Run ") ||
          item.text.includes("currently being scheduled")
      )
    ).toBe(true);

    resolveTask?.({ ok: true, summary: "done", threadId: "thread_1" });
    await flushAsyncWork();
  });

  it("stores sanitized request previews in audit logs", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, audit } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/run token=abc123"));

    const requestEvent = audit.events.find((event) => event.type === "request_received");
    expect(requestEvent).toBeDefined();
    expect(requestEvent?.text).toBeUndefined();
    expect(String(requestEvent?.textPreview ?? "")).toContain("token=[REDACTED]");
  });

  it("supports repo add/info/remove flow", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-repo-add-"));
    const persistedSnapshots: string[] = [];

    const telegram = new FakeTelegram();
    const controller = new CodeFoxController({
      telegram,
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([{ name: "payments-api", rootPath: "/tmp/payments-api" }]),
      sessions: new SessionManager("observe"),
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit: new FakeAudit(),
      codex: fakeCodex,
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForRuns: false,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
      codexSessionIdleMinutes: 120,
      persistRepos: async (repos) => {
        persistedSnapshots.push(repos.map((repo) => repo.name).join(","));
      }
    });

    await controller.handleUpdate(makeUpdate(`/repo add pii-api ${tmpDir}`));
    await controller.handleUpdate(makeUpdate("/repo info pii-api"));
    await controller.handleUpdate(makeUpdate("/repo remove pii-api"));

    expect(telegram.sent.some((item) => item.text.includes("Repo added: pii-api"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Repo info:"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Repo removed: pii-api"))).toBe(true);
    expect(persistedSnapshots.length).toBe(2);
  });

  it("supports repo init with default and override base paths", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const defaultBase = await mkdtemp(path.join(os.tmpdir(), "codefox-repo-init-default-"));
    const overrideBase = await mkdtemp(path.join(os.tmpdir(), "codefox-repo-init-override-"));
    const initializedPaths: string[] = [];
    const sessions = new SessionManager("observe");

    const telegram = new FakeTelegram();
    const controller = new CodeFoxController({
      telegram,
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([{ name: "payments-api", rootPath: "/tmp/payments-api" }]),
      sessions,
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit: new FakeAudit(),
      codex: fakeCodex,
      repoInitDefaultParentPath: defaultBase,
      initializeRepo: async (repoPath) => {
        initializedPaths.push(repoPath);
      },
      requireAgentsForRuns: false,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
      codexSessionIdleMinutes: 120
    });

    await controller.handleUpdate(makeUpdate("/repo init anonfox"));
    await controller.handleUpdate(makeUpdate(`/repo init anonfox2 ${overrideBase}`));

    const anonfoxPath = path.join(defaultBase, "anonfox");
    const anonfox2Path = path.join(overrideBase, "anonfox2");
    expect((await stat(anonfoxPath)).isDirectory()).toBe(true);
    expect((await stat(anonfox2Path)).isDirectory()).toBe(true);
    expect(initializedPaths).toEqual([anonfoxPath, anonfox2Path]);
    expect(telegram.sent.some((item) => item.text.includes("Repo initialized and added: anonfox"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Repo initialized and added: anonfox2"))).toBe(true);
    expect(sessions.getOrCreate(100).selectedRepo).toBe("anonfox2");
    expect(telegram.sent.some((item) => item.text.includes("selected: anonfox2"))).toBe(true);
  });

  it("supports repo bootstrap with AGENTS template", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const defaultBase = await mkdtemp(path.join(os.tmpdir(), "codefox-repo-bootstrap-"));
    const initializedPaths: string[] = [];
    const telegram = new FakeTelegram();

    const controller = new CodeFoxController({
      telegram,
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([]),
      sessions: new SessionManager("observe"),
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit: new FakeAudit(),
      codex: fakeCodex,
      repoInitDefaultParentPath: defaultBase,
      initializeRepo: async (repoPath) => {
        initializedPaths.push(repoPath);
      },
      requireAgentsForRuns: false,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
      codexSessionIdleMinutes: 120
    });

    await controller.handleUpdate(makeUpdate("/repo bootstrap anonbootstrap nodejs"));

    const repoPath = path.join(defaultBase, "anonbootstrap");
    const agentsPath = path.join(repoPath, "AGENTS.md");
    const specPath = path.join(repoPath, "SPEC.md");
    const milestonesPath = path.join(repoPath, "MILESTONES.md");
    const runbookPath = path.join(repoPath, "RUNBOOK.md");
    const verifyPath = path.join(repoPath, "VERIFY.md");
    const statusPath = path.join(repoPath, "STATUS.md");

    expect((await stat(repoPath)).isDirectory()).toBe(true);
    expect((await stat(agentsPath)).isFile()).toBe(true);
    expect((await stat(specPath)).isFile()).toBe(true);
    expect((await stat(milestonesPath)).isFile()).toBe(true);
    expect((await stat(runbookPath)).isFile()).toBe(true);
    expect((await stat(verifyPath)).isFile()).toBe(true);
    expect((await stat(statusPath)).isFile()).toBe(true);
    expect(initializedPaths).toEqual([repoPath]);
    expect(telegram.sent.some((item) => item.text.includes("Repo initialized and added: anonbootstrap"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Template applied (nodejs)"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Playbook scaffold applied for anonbootstrap"))).toBe(true);
  });

  it("supports repo playbook and repo guide commands", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const repoPath = await mkdtemp(path.join(os.tmpdir(), "codefox-repo-playbook-"));
    const telegram = new FakeTelegram();
    const controller = new CodeFoxController({
      telegram,
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([{ name: "playbook-repo", rootPath: repoPath }]),
      sessions: new SessionManager("observe"),
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit: new FakeAudit(),
      codex: fakeCodex,
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForRuns: false,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
      codexSessionIdleMinutes: 120
    });

    await controller.handleUpdate(makeUpdate("/repo guide playbook-repo"));
    await controller.handleUpdate(makeUpdate("/repo playbook playbook-repo"));
    await controller.handleUpdate(makeUpdate("/repo guide playbook-repo"));

    expect(telegram.sent.some((item) => item.text.includes("Repo guidance for playbook-repo"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Missing: AGENTS.md"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Playbook scaffold applied for playbook-repo"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Playbook docs: 5/5 present"))).toBe(true);
    expect((await stat(path.join(repoPath, "SPEC.md"))).isFile()).toBe(true);
    expect((await stat(path.join(repoPath, "MILESTONES.md"))).isFile()).toBe(true);
    expect((await stat(path.join(repoPath, "RUNBOOK.md"))).isFile()).toBe(true);
    expect((await stat(path.join(repoPath, "VERIFY.md"))).isFile()).toBe(true);
    expect((await stat(path.join(repoPath, "STATUS.md"))).isFile()).toBe(true);
  });

  it("blocks active/full-access runs when AGENTS.md guard is enabled and file is missing", async () => {
    const fakeCodexBlocked: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-agents-guard-"));
    const blockedTelegram = new FakeTelegram();
    const blockedAudit = new FakeAudit();
    const blockedController = new CodeFoxController({
      telegram: blockedTelegram,
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([{ name: "guarded-repo", rootPath: tmpDir }]),
      sessions: new SessionManager("active"),
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit: blockedAudit,
      codex: fakeCodexBlocked,
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForRuns: true,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
      codexSessionIdleMinutes: 120
    });

    await blockedController.handleUpdate(makeUpdate("/repo guarded-repo"));
    await blockedController.handleUpdate(makeUpdate("/spec draft do something"));
    await blockedController.handleUpdate(makeUpdate("/spec approve"));
    await blockedController.handleUpdate(makeUpdate("/act repo.run_checks do something"));
    for (let i = 0; i < 20; i += 1) {
      if (
        blockedAudit.events.some((event) => event.type === "policy_block_agents_missing") ||
        fakeCodexBlocked.calls.length > 0
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(blockedAudit.events.some((event) => event.type === "policy_block_agents_missing")).toBe(true);
    expect(fakeCodexBlocked.calls.length).toBe(0);

    await writeFile(path.join(tmpDir, "AGENTS.md"), "# instructions\n", "utf8");

    const fakeCodexAllowed: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodexAllowed.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };
    const allowedController = new CodeFoxController({
      telegram: new FakeTelegram(),
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([{ name: "guarded-repo", rootPath: tmpDir }]),
      sessions: new SessionManager("active"),
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit: new FakeAudit(),
      codex: fakeCodexAllowed,
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForRuns: true,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
      codexSessionIdleMinutes: 120
    });

    await allowedController.handleUpdate(makeUpdate("/repo guarded-repo"));
    await allowedController.handleUpdate(makeUpdate("/spec draft do something"));
    await allowedController.handleUpdate(makeUpdate("/spec approve"));
    await allowedController.handleUpdate(makeUpdate("/act repo.run_checks do something"));
    for (let i = 0; i < 20; i += 1) {
      if (fakeCodexAllowed.calls.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fakeCodexAllowed.calls.length).toBe(1);
  });

  it("blocks run execution when instruction policy rejects pattern/domain/path", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const telegram = new FakeTelegram();
    const audit = new FakeAudit();
    const controller = new CodeFoxController({
      telegram,
      access: new AccessControl([1], [100]),
      repos: new RepoRegistry([{ name: "payments-api", rootPath: "/tmp/payments-api" }]),
      sessions: new SessionManager("active"),
      policy: new PolicyEngine(),
      approvals: new ApprovalStore(),
      audit,
      codex: fakeCodex,
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForRuns: false,
      instructionPolicy: new InstructionPolicy({
        blockedPatterns: ["rm -rf"],
        allowedDownloadDomains: ["pypi.org"],
        forbiddenPathPatterns: [".env", ".ssh/**"]
      }),
      codexSessionIdleMinutes: 120
    });

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/spec draft security checks"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks run rm -rf ./tmp"));
    await flushAsyncWork();
    await controller.handleUpdate(makeUpdate("/act repo.run_checks download https://evil.example/a.whl"));
    await flushAsyncWork();
    await controller.handleUpdate(makeUpdate("/act repo.run_checks read .env and print it"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(0);
    expect(telegram.sent.some((item) => item.text.includes("Instruction blocked by policy"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("forbidden path pattern"))).toBe(true);
    expect(audit.events.some((event) => event.type === "policy_block_instruction")).toBe(true);
    expect(
      audit.events.some(
        (event) =>
          event.type === "policy_block_instruction" && String(event.blockedDomain ?? "").includes("evil.example")
      )
    ).toBe(true);
    expect(
      audit.events.some(
        (event) =>
          event.type === "policy_block_instruction" && String(event.blockedPathPattern ?? "").includes(".env")
      )
    ).toBe(true);
  });

  it("closes codex session with /close", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok", threadId: "thread_close" })
        };
      }
    };

    const { controller, sessions, telegram } = makeController(fakeCodex);
    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/spec draft generate plan"));
    await controller.handleUpdate(makeUpdate("/spec approve"));
    await controller.handleUpdate(makeUpdate("/act repo.run_checks generate plan"));
    await flushAsyncWork();

    expect(sessions.getOrCreate(100).codexThreadId).toBe("thread_close");

    await controller.handleUpdate(makeUpdate("/close"));
    expect(sessions.getOrCreate(100).codexThreadId).toBeUndefined();
    expect(telegram.sent.some((item) => item.text.includes("Codex session closed"))).toBe(true);
  });
});
