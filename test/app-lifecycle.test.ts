import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

describe("createApp lifecycle", () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:valid";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof originalToken === "undefined") {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });

  it("starts and stops gracefully with lifecycle audit events", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-test-"));
    const logPath = path.join(tmpDir, "audit.log");
    const statePath = path.join(tmpDir, "state.json");
    const configPath = path.join(tmpDir, "codefox.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        telegram: {
          allowedUserIds: [1],
          allowedChatIds: [100],
          pollingTimeoutSeconds: 1,
          pollIntervalMs: 1
        },
        repos: [{ name: "payments-api", rootPath: tmpDir }],
        codex: {
          command: "codex",
          baseArgs: [],
          runArgTemplate: ["{instruction}"],
          repoArgTemplate: [],
          timeoutMs: 1000,
          preflightEnabled: false
        },
        policy: { defaultMode: "observe" },
        state: { filePath: statePath, codexSessionIdleMinutes: 120 },
        audit: { logFilePath: logPath }
      }),
      "utf8"
    );

    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ ok: true, result: [] })
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await createApp(configPath);
    const startPromise = app.start();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.stop();
    await Promise.race([startPromise, new Promise((resolve) => setTimeout(resolve, 250))]);

    const logs = await readFile(logPath, "utf8");
    expect(logs).toContain('"type":"service_start"');
    expect(logs).toContain('"type":"service_stop"');
  });

  it("prunes stale persisted state on startup when TTL is configured", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-test-"));
    const logPath = path.join(tmpDir, "audit.log");
    const statePath = path.join(tmpDir, "state.json");
    const configPath = path.join(tmpDir, "codefox.config.json");

    await writeFile(
      statePath,
      JSON.stringify(
        {
          sessions: [
            { chatId: 100, mode: "observe", updatedAt: "2026-01-01T11:30:00.000Z" },
            { chatId: 101, mode: "active", updatedAt: "2000-01-01T10:00:00.000Z" }
          ],
          approvals: [
            {
              id: "fresh",
              chatId: 100,
              userId: 1,
              repoName: "payments-api",
              mode: "active",
              instruction: "fix tests",
              createdAt: "2026-01-01T11:00:00.000Z"
            },
            {
              id: "stale",
              chatId: 101,
              userId: 1,
              repoName: "payments-api",
              mode: "active",
              instruction: "fix tests",
              createdAt: "2000-01-01T11:00:00.000Z"
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    await writeFile(
      configPath,
      JSON.stringify({
        telegram: {
          allowedUserIds: [1],
          allowedChatIds: [100],
          pollingTimeoutSeconds: 1,
          pollIntervalMs: 1
        },
        repos: [{ name: "payments-api", rootPath: tmpDir }],
        codex: {
          command: "codex",
          baseArgs: [],
          runArgTemplate: ["{instruction}"],
          repoArgTemplate: [],
          timeoutMs: 1000,
          preflightEnabled: false
        },
        policy: { defaultMode: "observe" },
        state: {
          filePath: statePath,
          sessionTtlHours: 1,
          approvalTtlHours: 1,
          codexSessionIdleMinutes: 120
        },
        audit: { logFilePath: logPath }
      }),
      "utf8"
    );

    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ ok: true, result: [] })
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const app = await createApp(configPath);
    vi.useRealTimers();

    const startPromise = app.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.stop();
    await Promise.race([startPromise, new Promise((resolve) => setTimeout(resolve, 250))]);
    vi.useRealTimers();

    const savedState = JSON.parse(await readFile(statePath, "utf8")) as {
      sessions: Array<{ chatId: number }>;
      approvals: Array<{ id: string }>;
    };

    expect(savedState.sessions).toEqual([{ chatId: 100, mode: "observe", updatedAt: "2026-01-01T11:30:00.000Z" }]);
    expect(savedState.approvals).toEqual([
      {
        id: "fresh",
        chatId: 100,
        userId: 1,
        repoName: "payments-api",
        mode: "active",
        instruction: "fix tests",
        createdAt: "2026-01-01T11:00:00.000Z"
      }
    ]);

    const logs = await readFile(logPath, "utf8");
    expect(logs).toContain('"type":"state_pruned"');
  });
});
