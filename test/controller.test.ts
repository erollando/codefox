import { mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunningTask } from "../src/adapters/codex.js";
import type { TaskContext, TaskResult } from "../src/types/domain.js";
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
}

class FakeTelegram {
  readonly sent: SentMessage[] = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

class FakeAudit {
  readonly events: Array<Record<string, unknown>> = [];

  async log(event: Record<string, unknown>): Promise<void> {
    this.events.push(event);
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

function makeController(fakeCodex: FakeCodex, options?: { allowedUserIds?: number[] }) {
  const telegram = new FakeTelegram();
  const audit = new FakeAudit();
  const approvals = new ApprovalStore();
  const sessions = new SessionManager("observe");

  const controller = new CodeFoxController({
    telegram,
    access: new AccessControl(options?.allowedUserIds ?? [1], [100]),
    repos: new RepoRegistry([{ name: "payments-api", rootPath: "/tmp/payments-api" }]),
    sessions,
    policy: new PolicyEngine(),
    approvals,
    audit,
    codex: fakeCodex,
    plainTextMode: "task",
    repoInitDefaultParentPath: "/tmp",
    initializeRepo: async () => {},
    requireAgentsForMutatingTasks: false,
    instructionPolicy: new InstructionPolicy({
      enforceOnAsk: false,
      blockedPatterns: [],
      allowedDownloadDomains: [],
      forbiddenPathPatterns: []
    })
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

  it("executes task directly in active mode", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask(repoPath, context) {
        fakeCodex.calls.push({ repoPath, context });
        const result: TaskResult = {
          ok: true,
          summary: "done"
        };
        return { abort: () => {}, result: Promise.resolve(result) };
      }
    };

    const { controller, telegram, approvals } = makeController(fakeCodex);

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/task fix failing test"));
    await flushAsyncWork();

    const pending = approvals.get(100);
    expect(pending).toBeUndefined();

    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.taskType).toBe("task");
    expect(telegram.sent.some((item) => item.text.includes("Started request"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Task completed."))).toBe(true);
  });

  it("shows pending approval details via /pending", async () => {
    const fakeCodex: FakeCodex = {
      calls: [],
      startTask() {
        return {
          abort: () => {},
          result: Promise.resolve({ ok: true, summary: "ok" })
        };
      }
    };

    const { controller, telegram, approvals } = makeController(fakeCodex);
    approvals.set({
      id: "pending-1",
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      taskType: "task",
      instruction: "fix failing test",
      createdAt: new Date().toISOString()
    });
    await controller.handleUpdate(makeUpdate("/pending"));

    expect(telegram.sent.some((item) => item.text.includes("Pending approval:"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("instruction: fix failing test"))).toBe(true);
  });

  it("allows only the requesting user to approve or deny pending requests", async () => {
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
    approvals.set({
      id: "req-1",
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      taskType: "task",
      instruction: "token=abc123",
      createdAt: new Date().toISOString()
    });

    await controller.handleUpdate(makeUpdate("/approve", 2));
    await controller.handleUpdate(makeUpdate("/deny", 2));
    await flushAsyncWork();

    expect(
      telegram.sent.some((item) => item.text.includes("Only the requesting user can approve this request."))
    ).toBe(true);
    expect(
      telegram.sent.some((item) => item.text.includes("Only the requesting user can deny this request."))
    ).toBe(true);
    expect(fakeCodex.calls.length).toBe(0);

    await controller.handleUpdate(makeUpdate("/approve", 1));
    await flushAsyncWork();
    expect(fakeCodex.calls.length).toBe(1);
  });

  it("blocks mutating task in observe mode", async () => {
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

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/task update pom"));
    await flushAsyncWork();

    expect(telegram.sent.some((item) => item.text.includes("observe mode blocks mutating tasks"))).toBe(true);
    expect(fakeCodex.calls.length).toBe(0);
  });

  it("prevents concurrent tasks and supports abort", async () => {
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
              summary: "Task aborted by user.",
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

    await controller.handleUpdate(makeUpdate("/task long running change"));
    await flushAsyncWork();

    await controller.handleUpdate(makeUpdate("/task second request"));
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
          item.text.includes("currently being scheduled")
      )
    ).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Abort signal sent"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Task aborted."))).toBe(true);
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
    await controller.handleUpdate(makeUpdate("/ask token=abc123"));

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
      plainTextMode: "task",
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForMutatingTasks: false,
      instructionPolicy: new InstructionPolicy({
        enforceOnAsk: false,
        blockedPatterns: [],
        allowedDownloadDomains: []
      }),
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
      plainTextMode: "task",
      repoInitDefaultParentPath: defaultBase,
      initializeRepo: async (repoPath) => {
        initializedPaths.push(repoPath);
      },
      requireAgentsForMutatingTasks: false,
      instructionPolicy: new InstructionPolicy({
        enforceOnAsk: false,
        blockedPatterns: [],
        allowedDownloadDomains: []
      })
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

  it("blocks mutating tasks when AGENTS.md guard is enabled and file is missing", async () => {
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
      plainTextMode: "task",
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForMutatingTasks: true,
      instructionPolicy: new InstructionPolicy({
        enforceOnAsk: false,
        blockedPatterns: [],
        allowedDownloadDomains: []
      })
    });

    await blockedController.handleUpdate(makeUpdate("/repo guarded-repo"));
    await blockedController.handleUpdate(makeUpdate("/task do something"));
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
      plainTextMode: "task",
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForMutatingTasks: true,
      instructionPolicy: new InstructionPolicy({
        enforceOnAsk: false,
        blockedPatterns: [],
        allowedDownloadDomains: []
      })
    });

    await allowedController.handleUpdate(makeUpdate("/repo guarded-repo"));
    await allowedController.handleUpdate(makeUpdate("/task do something"));
    for (let i = 0; i < 20; i += 1) {
      if (fakeCodexAllowed.calls.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fakeCodexAllowed.calls.length).toBe(1);
  });

  it("blocks task execution when instruction policy rejects pattern/domain", async () => {
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
      plainTextMode: "task",
      repoInitDefaultParentPath: "/tmp",
      initializeRepo: async () => {},
      requireAgentsForMutatingTasks: false,
      instructionPolicy: new InstructionPolicy({
        enforceOnAsk: false,
        blockedPatterns: ["rm -rf"],
        allowedDownloadDomains: ["pypi.org"],
        forbiddenPathPatterns: [".env", ".ssh/**"]
      })
    });

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/task run rm -rf ./tmp"));
    await controller.handleUpdate(makeUpdate("/task download https://evil.example/a.whl"));
    await controller.handleUpdate(makeUpdate("/task read .env and print it"));
    await flushAsyncWork();

    expect(fakeCodex.calls.length).toBe(0);
    expect(telegram.sent.some((item) => item.text.includes("Instruction blocked by policy"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("blocked domain"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("forbidden path pattern"))).toBe(true);
    expect(audit.events.some((event) => event.type === "policy_block_instruction")).toBe(true);
    expect(
      audit.events.some(
        (event) =>
          event.type === "policy_block_instruction" && String(event.blockedPathPattern ?? "").includes(".env")
      )
    ).toBe(true);
  });
});
