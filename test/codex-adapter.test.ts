import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CodexCliAdapter, type ProcessRunner } from "../src/adapters/codex.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { TaskContext } from "../src/types/domain.js";

class FakeStream extends EventEmitter {
  emitData(text: string): void {
    this.emit("data", Buffer.from(text, "utf8"));
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;

  kill(): void {
    this.killed = true;
    this.emit("close", 143);
  }
}

describe("CodexCliAdapter", () => {
  it("builds args and returns success result", async () => {
    let capturedCommand = "";
    let capturedArgs: string[] = [];

    const runner: ProcessRunner = {
      spawn(command, args) {
        capturedCommand = command;
        capturedArgs = args;

        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData("working\n");
          child.stdout.emitData("done\n");
          child.emit("close", 0);
        });

        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: true,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "fix tests",
      requestId: "abc123",
      runKind: "run",
      systemGuidance: ["Never read .env files."]
    };

    const running = adapter.startTask("/tmp/payments-api", context);
    const result = await running.result;

    expect(capturedCommand).toBe("codex");
    expect(capturedArgs[0]).toBe("exec");
    expect(capturedArgs).toContain("--sandbox");
    expect(capturedArgs).toContain("workspace-write");
    expect(capturedArgs.join(" ")).toContain("fix tests");
    expect(capturedArgs.join(" ")).toContain("System safety guidance:");
    expect(capturedArgs.join(" ")).toContain("Never read .env files.");
    expect(result.ok).toBe(true);
  });

  it("supports abort", async () => {
    let fakeChild: FakeChild | undefined;

    const runner: ProcessRunner = {
      spawn() {
        fakeChild = new FakeChild();
        return fakeChild as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: [],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: true,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "status",
      requestId: "def456",
      runKind: "run"
    };

    const running = adapter.startTask("/tmp/payments-api", context);
    running.abort();
    const result = await running.result;

    expect(fakeChild?.killed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.summary).toContain("aborted");
  });

  it("reports timeout when process exceeds timeoutMs", async () => {
    const runner: ProcessRunner = {
      spawn() {
        return new FakeChild() as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: [],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 1,
        blockedEnvVars: [],
        preflightEnabled: true,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "status",
      requestId: "ghi789",
      runKind: "run"
    };

    const running = adapter.startTask("/tmp/payments-api", context);
    const result = await running.result;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.summary).toContain("timed out");
  });

  it("emits progress lines correctly across chunk boundaries", async () => {
    const seen: string[] = [];

    const runner: ProcessRunner = {
      spawn() {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData("hel");
          child.stdout.emitData("lo\nwor");
          child.stdout.emitData("ld\n");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: [],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: true,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "status",
      requestId: "jkl012",
      runKind: "run"
    };

    const running = adapter.startTask("/tmp/payments-api", context, (line) => {
      seen.push(line);
    });
    await running.result;

    expect(seen).toEqual(["hello", "world"]);
  });

  it("filters blocked env vars before spawning codex", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const previousTelegram = process.env.TELEGRAM_BOT_TOKEN;
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousCodefox = process.env.CODEFOX_CONFIG;

    process.env.TELEGRAM_BOT_TOKEN = "secret-telegram-token";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.CODEFOX_CONFIG = "/tmp/codefox.config.json";

    const runner: ProcessRunner = {
      spawn(_command, _args, options) {
        capturedEnv = options.env;
        const child = new FakeChild();
        queueMicrotask(() => child.emit("close", 0));
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: [],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: ["TELEGRAM_BOT_TOKEN", "CODEFOX_*"],
        preflightEnabled: true,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "status",
      requestId: "env001",
      runKind: "run"
    };

    try {
      await adapter.startTask("/tmp/payments-api", context).result;

      expect(capturedEnv?.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(capturedEnv?.CODEFOX_CONFIG).toBeUndefined();
      expect(capturedEnv?.OPENAI_API_KEY).toBe("openai-key");
    } finally {
      if (typeof previousTelegram === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousTelegram;
      }
      if (typeof previousOpenAi === "undefined") {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAi;
      }
      if (typeof previousCodefox === "undefined") {
        delete process.env.CODEFOX_CONFIG;
      } else {
        process.env.CODEFOX_CONFIG = previousCodefox;
      }
    }
  });

  it("fails preflight when codex command cannot start", async () => {
    const runner: ProcessRunner = {
      spawn() {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.emit("error", new Error("spawn ENOENT"));
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: [],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: true,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    await expect(adapter.ensureAvailable()).rejects.toThrowError(/Failed to start Codex command/);
  });

  it("injects read-only sandbox for observe mode when sandbox flags are absent", async () => {
    let capturedArgs: string[] = [];
    const runner: ProcessRunner = {
      spawn(_command, args) {
        capturedArgs = args;
        const child = new FakeChild();
        queueMicrotask(() => child.emit("close", 0));
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "observe",
      instruction: "status",
      requestId: "obs001",
      runKind: "run"
    };

    await adapter.startTask("/tmp/payments-api", context).result;
    expect(capturedArgs).toContain("--sandbox");
    expect(capturedArgs).toContain("read-only");
  });

  it("injects danger-full-access sandbox for full-access mode when sandbox flags are absent", async () => {
    let capturedArgs: string[] = [];
    const runner: ProcessRunner = {
      spawn(_command, args) {
        capturedArgs = args;
        const child = new FakeChild();
        queueMicrotask(() => child.emit("close", 0));
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "full-access",
      instruction: "install dependencies",
      requestId: "full001",
      runKind: "run"
    };

    await adapter.startTask("/tmp/payments-api", context).result;
    expect(capturedArgs).toContain("--sandbox");
    expect(capturedArgs).toContain("danger-full-access");
  });

  it("injects codex resume args and captures thread id from output", async () => {
    let capturedArgs: string[] = [];
    const runner: ProcessRunner = {
      spawn(_command, args) {
        capturedArgs = args;
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData('{"thread_id":"thread_abc"}\n');
          child.emit("close", 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "continue",
      requestId: "resume001",
      runKind: "steer",
      resumeThreadId: "thread_old"
    };

    const result = await adapter.startTask("/tmp/payments-api", context).result;
    expect(capturedArgs).toContain("resume");
    expect(capturedArgs).toContain("thread_old");
    expect(result.threadId).toBe("thread_abc");
  });

  it("captures plain-text codex session id for future resume", async () => {
    const runner: ProcessRunner = {
      spawn() {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData("session id: 019cccf2-3c55-74c1-81ca-b312d7281274\n");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "status",
      requestId: "sess001",
      runKind: "run"
    };

    const result = await adapter.startTask("/tmp/payments-api", context).result;
    expect(result.threadId).toBe("019cccf2-3c55-74c1-81ca-b312d7281274");
  });

  it("uses the assistant message instead of token counters as summary", async () => {
    const runner: ProcessRunner = {
      spawn() {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData("OpenAI Codex v0.111.0 (research preview)\n");
          child.stdout.emitData("session id: 019cccf2-3c55-74c1-81ca-b312d7281274\n");
          child.stdout.emitData("user\n");
          child.stdout.emitData("question\n");
          child.stdout.emitData("codex\n");
          child.stdout.emitData("Yes, this is the answer.\n");
          child.stdout.emitData("tokens used\n");
          child.stdout.emitData("2,092\n");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "status",
      requestId: "sum001",
      runKind: "run"
    };

    const result = await adapter.startTask("/tmp/payments-api", context).result;
    expect(result.summary).toBe("Yes, this is the answer.");
  });

  it("uses the latest codex message block instead of early planning/tool chatter", async () => {
    const runner: ProcessRunner = {
      spawn() {
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData("codex\n");
          child.stdout.emitData("I'm going to check staged changes and remotes.\n");
          child.stdout.emitData("exec\n");
          child.stdout.emitData("/bin/bash -lc 'git status --short --branch' in /home/enrico/git/codefoxexec\n");
          child.stdout.emitData("codex\n");
          child.stdout.emitData("Done.\n");
          child.stdout.emitData("- Committed: d0807dc on main\n");
          child.stdout.emitData("- Pushed to: origin/main\n");
          child.stdout.emitData("tokens used\n");
          child.stdout.emitData("123\n");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "commit and push",
      requestId: "sum002",
      runKind: "run"
    };

    const result = await adapter.startTask("/tmp/payments-api", context).result;
    expect(result.summary).toContain("Done.");
    expect(result.summary).toContain("Committed: d0807dc");
    expect(result.summary).not.toContain("I'm going to check");
    expect(result.summary).not.toContain("git status");
  });

  it("prepends codex global runtime flags from config", async () => {
    let capturedArgs: string[] = [];
    const runner: ProcessRunner = {
      spawn(_command, args) {
        capturedArgs = args;
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData("ok\n");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        model: "gpt-5.3-codex",
        reasoningEffort: "low",
        configOverrides: ['model_reasoning_summary="none"'],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      instruction: "status",
      requestId: "flags001",
      runKind: "run",
      attachments: [
        {
          kind: "image",
          localPath: "/tmp/photo.png",
          originalName: "photo.png",
          mimeType: "image/png"
        }
      ]
    };

    await adapter.startTask("/tmp/payments-api", context).result;

    expect(capturedArgs.slice(0, 2)).toEqual(["--model", "gpt-5.3-codex"]);
    expect(capturedArgs).toContain("-c");
    expect(capturedArgs).toContain('model_reasoning_effort="low"');
    expect(capturedArgs).toContain('model_reasoning_summary="none"');
    expect(capturedArgs).toContain("--image");
    expect(capturedArgs).toContain("/tmp/photo.png");
    expect(capturedArgs).toContain("exec");
  });

  it("adds non-image attachments to instruction context without using --image", async () => {
    let capturedArgs: string[] = [];
    const runner: ProcessRunner = {
      spawn(_command, args) {
        capturedArgs = args;
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.emitData("ok\n");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    };

    const adapter = new CodexCliAdapter(
      {
        command: "codex",
        baseArgs: ["exec"],
        runArgTemplate: ["{instruction}"],
        repoArgTemplate: [],
        timeoutMs: 5000,
        blockedEnvVars: [],
        preflightEnabled: false,
        preflightArgs: ["--version"],
        preflightTimeoutMs: 1000
      },
      runner
    );

    const context: TaskContext = {
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "observe",
      instruction: "summarize attached document",
      requestId: "doc001",
      runKind: "run",
      attachments: [
        {
          kind: "document",
          localPath: "/tmp/doc.md",
          originalName: "doc.md",
          mimeType: "text/markdown"
        }
      ]
    };

    await adapter.startTask("/tmp/payments-api", context).result;

    expect(capturedArgs).not.toContain("--image");
    expect(capturedArgs.join(" ")).toContain("Attachments:");
    expect(capturedArgs.join(" ")).toContain("/tmp/doc.md");
    expect(capturedArgs.join(" ")).toContain("summarize attached document");
  });
});
