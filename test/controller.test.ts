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
  }
) {
  const telegram = options?.telegram ?? new FakeTelegram();
  const audit = new FakeAudit();
  const approvals = new ApprovalStore();
  const sessions = new SessionManager(options?.defaultMode ?? "observe");

  const controller = new CodeFoxController({
    telegram,
    access: new AccessControl(options?.allowedUserIds ?? [1], [100]),
    repos: new RepoRegistry([{ name: "payments-api", rootPath: "/tmp/payments-api" }]),
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
    codexSessionIdleMinutes: 120
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

  it("executes /run directly in active mode", async () => {
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

    const { controller, telegram, approvals, sessions } = makeController(fakeCodex);

    await controller.handleUpdate(makeUpdate("/repo payments-api"));
    await controller.handleUpdate(makeUpdate("/mode active"));
    await controller.handleUpdate(makeUpdate("/run fix failing test"));
    await flushAsyncWork();

    expect(approvals.get(100)).toBeUndefined();
    expect(fakeCodex.calls.length).toBe(1);
    expect(fakeCodex.calls[0].context.runKind).toBe("run");
    expect(fakeCodex.calls[0].context.mode).toBe("active");
    expect(telegram.sent.some((item) => item.text.includes("Started request"))).toBe(true);
    expect(telegram.sent.some((item) => item.text.includes("Run completed."))).toBe(true);
    expect(sessions.getOrCreate(100).codexThreadId).toBe("thread_1");
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

  it("executes /run directly in full-access mode without codefox pre-run approval", async () => {
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
    await controller.handleUpdate(makeUpdate("/run install dependencies"));
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

    await controller.handleUpdate(makeUpdate("/run long running change"));
    await flushAsyncWork();

    await controller.handleUpdate(makeUpdate("/run second request"));
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
    expect(telegram.sent.some((item) => item.text.includes("Run aborted."))).toBe(true);
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
    await controller.handleUpdate(makeUpdate("/run first run"));
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
    await blockedController.handleUpdate(makeUpdate("/run do something"));
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
    await allowedController.handleUpdate(makeUpdate("/run do something"));
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
    await controller.handleUpdate(makeUpdate("/run run rm -rf ./tmp"));
    await controller.handleUpdate(makeUpdate("/run download https://evil.example/a.whl"));
    await controller.handleUpdate(makeUpdate("/run read .env and print it"));
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
    await controller.handleUpdate(makeUpdate("/run generate plan"));
    await flushAsyncWork();

    expect(sessions.getOrCreate(100).codexThreadId).toBe("thread_close");

    await controller.handleUpdate(makeUpdate("/close"));
    expect(sessions.getOrCreate(100).codexThreadId).toBeUndefined();
    expect(telegram.sent.some((item) => item.text.includes("Codex session closed"))).toBe(true);
  });
});
