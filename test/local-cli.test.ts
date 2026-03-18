import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  determineMissingRelayStartMode,
  parseLocalCliArgs,
  parseMissingRelayStartPromptAnswer,
  runLocalCli
} from "../src/core/local-cli.js";

function isLoopbackPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = Reflect.get(error, "code");
  return code === "EPERM" || code === "EACCES";
}

async function listenOnLoopbackOrSkip(server: Server): Promise<number | undefined> {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
  } catch (error) {
    if (isLoopbackPermissionError(error)) {
      return undefined;
    }
    throw error;
  }

  const relayAddress = server.address();
  if (!relayAddress || typeof relayAddress === "string") {
    throw new Error("Expected relay server to provide numeric host/port address.");
  }
  return relayAddress.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (!error) {
        resolve();
        return;
      }
      if (error.message.includes("Server is not running")) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

describe("local CLI", () => {
  it("parses supported commands and config override", () => {
    const parsed = parseLocalCliArgs(["--config", "./config/custom.json", "session", "100"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.args) {
      return;
    }

    expect(parsed.args.command).toBe("session");
    expect(parsed.args.chatId).toBe(100);
    expect(parsed.args.configPath).toBe("./config/custom.json");
  });

  it("parses send command with optional --user", () => {
    const parsed = parseLocalCliArgs(["--config", "./config/custom.json", "--user", "9", "send", "100", "/status"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.args) {
      return;
    }

    expect(parsed.args.command).toBe("send");
    expect(parsed.args.chatId).toBe(100);
    expect(parsed.args.userId).toBe(9);
    expect(parsed.args.text).toBe("/status");
  });

  it("parses local shortcut commands", () => {
    const dashboard = parseLocalCliArgs(["dashboard"]);
    expect(dashboard.ok).toBe(true);
    if (!dashboard.ok || !dashboard.args) {
      return;
    }
    expect(dashboard.args.command).toBe("dashboard");

    const dashboardWatch = parseLocalCliArgs(["dashboard", "--watch"]);
    expect(dashboardWatch.ok).toBe(true);
    if (!dashboardWatch.ok || !dashboardWatch.args) {
      return;
    }
    expect(dashboardWatch.args.command).toBe("dashboard");
    expect(dashboardWatch.args.watch).toBe(true);

    const approve = parseLocalCliArgs(["approve", "100"]);
    expect(approve.ok).toBe(true);
    if (!approve.ok || !approve.args) {
      return;
    }
    expect(approve.args.command).toBe("approve");
    expect(approve.args.chatId).toBe(100);

    const deny = parseLocalCliArgs(["deny"]);
    expect(deny.ok).toBe(true);
    if (!deny.ok || !deny.args) {
      return;
    }
    expect(deny.args.command).toBe("deny");
    expect(deny.args.chatId).toBeUndefined();

    const status = parseLocalCliArgs(["status", "100"]);
    expect(status.ok).toBe(true);
    if (!status.ok || !status.args) {
      return;
    }
    expect(status.args.command).toBe("status");
    expect(status.args.chatId).toBe(100);

    const contWithChat = parseLocalCliArgs(["continue", "100", "rw-2"]);
    expect(contWithChat.ok).toBe(true);
    if (!contWithChat.ok || !contWithChat.args) {
      return;
    }
    expect(contWithChat.args.command).toBe("continue");
    expect(contWithChat.args.chatId).toBe(100);
    expect(contWithChat.args.workId).toBe("rw-2");

    const contWithoutChat = parseLocalCliArgs(["continue", "rw-3"]);
    expect(contWithoutChat.ok).toBe(true);
    if (!contWithoutChat.ok || !contWithoutChat.args) {
      return;
    }
    expect(contWithoutChat.args.command).toBe("continue");
    expect(contWithoutChat.args.chatId).toBeUndefined();
    expect(contWithoutChat.args.workId).toBe("rw-3");

    const stop = parseLocalCliArgs(["stop"]);
    expect(stop.ok).toBe(true);
    if (!stop.ok || !stop.args) {
      return;
    }
    expect(stop.args.command).toBe("stop");
  });

  it("parses handoff command with required and optional flags", () => {
    const parsed = parseLocalCliArgs([
      "handoff",
      "100",
      "--task",
      "TASK-123",
      "--remaining",
      "Run regression suite",
      "--completed",
      "Implemented endpoint",
      "--risk",
      "Regression may fail",
      "--repo-path",
      "/tmp/payments-api",
      "--start-in-foreground"
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.args) {
      return;
    }
    expect(parsed.args.command).toBe("handoff");
    expect(parsed.args.chatId).toBe(100);
    expect(parsed.args.taskId).toBe("TASK-123");
    expect(parsed.args.remainingSummary).toBe("Run regression suite");
    expect(parsed.args.completedWork).toEqual(["Implemented endpoint"]);
    expect(parsed.args.unresolvedRisks).toEqual(["Regression may fail"]);
    expect(parsed.args.repoPath).toBe("/tmp/payments-api");
    expect(parsed.args.startIfMissingRelay).toBe(true);
    expect(parsed.args.relayStartMode).toBe("foreground");
  });

  it("keeps --start-if-missing as a background-start compatibility alias", () => {
    const parsed = parseLocalCliArgs(["handoff", "--start-if-missing"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.args) {
      return;
    }
    expect(parsed.args.command).toBe("handoff");
    expect(parsed.args.startIfMissingRelay).toBe(true);
    expect(parsed.args.relayStartMode).toBe("background");
  });

  it("parses handoff command without chatId and taskId", () => {
    const parsed = parseLocalCliArgs(["handoff"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.args) {
      return;
    }
    expect(parsed.args.command).toBe("handoff");
    expect(parsed.args.chatId).toBeUndefined();
    expect(parsed.args.taskId).toBeUndefined();
    expect(parsed.args.remainingSummary).toBeUndefined();
  });

  it("resolves missing-relay start mode precedence", () => {
    expect(determineMissingRelayStartMode({}, true)).toBe("prompt");
    expect(determineMissingRelayStartMode({}, false)).toBe("none");
    expect(determineMissingRelayStartMode({ startIfMissingRelay: false }, true)).toBe("none");
    expect(determineMissingRelayStartMode({ relayStartMode: "foreground" }, false)).toBe("foreground");
    expect(determineMissingRelayStartMode({ startIfMissingRelay: true }, true)).toBe("background");
    expect(
      determineMissingRelayStartMode(
        {
          startIfMissingRelay: true,
          relayStartMode: "background"
        },
        true
      )
    ).toBe("background");
  });

  it("parses foreground/background/no answers for missing-relay prompt", () => {
    expect(parseMissingRelayStartPromptAnswer("")).toBe("foreground");
    expect(parseMissingRelayStartPromptAnswer("f")).toBe("foreground");
    expect(parseMissingRelayStartPromptAnswer("background")).toBe("background");
    expect(parseMissingRelayStartPromptAnswer("n")).toBe("none");
    expect(parseMissingRelayStartPromptAnswer("later")).toBe("none");
  });

  it("returns parse errors for invalid session command", () => {
    const missing = parseLocalCliArgs(["session"]);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("requires <chatId>");

    const invalid = parseLocalCliArgs(["session", "abc"]);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("positive integer");

    const invalidContinue = parseLocalCliArgs(["continue", "rw-1", "extra"]);
    expect(invalidContinue.ok).toBe(false);
    expect(invalidContinue.error).toContain("continue command format");

    const invalidWatch = parseLocalCliArgs(["sessions", "--watch"]);
    expect(invalidWatch.ok).toBe(false);
    expect(invalidWatch.error).toContain("--watch is only supported");
  });

  it("renders persisted session/spec/approval views", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [1],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [
            {
              chatId: 100,
              selectedRepo: "payments-api",
              mode: "active",
              activeRequestId: "req_1",
              codexThreadId: "thread_1",
              updatedAt: "2026-03-14T12:00:00.000Z"
            }
          ],
          approvals: [
            {
              id: "req_1",
              chatId: 100,
              userId: 1,
              repoName: "payments-api",
              mode: "active",
              instruction: "prepare branch",
              capabilityRef: "repo.prepare_branch",
              createdAt: "2026-03-14T12:00:01.000Z"
            }
          ],
          specWorkflows: [
            {
              chatId: 100,
              workflow: {
                revisions: [
                  {
                    version: 2,
                    stage: "approved",
                    status: "approved",
                    sourceIntent: "prepare branch",
                    createdAt: "2026-03-14T12:00:00.000Z",
                    updatedAt: "2026-03-14T12:00:03.000Z",
                    approvedAt: "2026-03-14T12:00:03.000Z",
                    sections: {
                      REQUEST: "prepare branch",
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
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    let sessionsExit = 0;
    let dashboardExit = 0;
    let approvalsExit = 0;
    let specsExit = 0;
    let sessionExit = 0;
    try {
      sessionsExit = await runLocalCli(["--config", configPath, "sessions"], output);
      dashboardExit = await runLocalCli(["--config", configPath, "dashboard"], output);
      approvalsExit = await runLocalCli(["--config", configPath, "approvals"], output);
      specsExit = await runLocalCli(["--config", configPath, "specs"], output);
      sessionExit = await runLocalCli(["--config", configPath, "session", "100"], output);
    } finally {
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }

    expect(sessionsExit).toBe(0);
    expect(dashboardExit).toBe(0);
    expect(approvalsExit).toBe(0);
    expect(specsExit).toBe(0);
    expect(sessionExit).toBe(0);
    expect(errors).toEqual([]);

    const rendered = logs.join("\n\n");
    expect(rendered).toContain("Sessions:");
    expect(rendered).toContain("Dashboard:");
    expect(rendered).toContain("summary: sessions=1 approvals=1 specs=1");
    expect(rendered).toContain("Approvals:");
    expect(rendered).toContain("Specs:");
    expect(rendered).toContain("Session 100:");
    expect(rendered).toContain("capability=repo.prepare_branch");
    expect(rendered).toContain("current spec: v2 (approved, approved)");
  });

  it("queues local send commands to inbox", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-send-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    try {
      const code = await runLocalCli(["--config", configPath, "send", "100", "/status"], output);
      expect(code).toBe(0);
    } finally {
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }

    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Queued local command");
    expect(logs.join("\n")).toContain("Queue inbox:");
  });

  it("queues local shortcut commands with auto-selected chat", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-shortcuts-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [
            {
              chatId: 100,
              selectedRepo: "payments-api",
              mode: "active",
              updatedAt: "2026-03-14T12:00:00.000Z"
            }
          ],
          approvals: [],
          specWorkflows: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    try {
      const approveCode = await runLocalCli(["--config", configPath, "approve"], output);
      const statusCode = await runLocalCli(["--config", configPath, "status"], output);
      const continueCode = await runLocalCli(["--config", configPath, "continue", "rw-1"], output);
      expect(approveCode).toBe(0);
      expect(statusCode).toBe(0);
      expect(continueCode).toBe(0);
    } finally {
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }

    expect(errors).toEqual([]);
    const rendered = logs.join("\n");
    expect(rendered).toContain("Auto-selected chat 100.");
    expect(rendered).toContain(": /approve");
    expect(rendered).toContain(": /status");
    expect(rendered).toContain(": /continue rw-1");
  });

  it("runs handoff command by automating routes bind event handoff and revoke", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-handoff-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const relayToken = "relay-test-token";
    const relayRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

    const relayServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      req.on("end", () => {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${relayToken}`) {
          res.statusCode = 401;
          res.end(`${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`);
          return;
        }
        const method = req.method ?? "GET";
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathName = requestUrl.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8").trim();
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        relayRequests.push({ method, path: pathName, body });

        if (method === "GET" && pathName === "/v1/external-codex/routes") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              routes: [{ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 }]
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/bind") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              lease: {
                leaseId: "lease_test_1",
                schemaVersion: "v1",
                session: { sessionId: "chat:100/repo:payments-api/mode:active" }
              },
              manifest: {
                schemaVersion: "v1",
                capabilityClasses: ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
                maxLeaseSeconds: 600
              }
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/event") {
          res.statusCode = 202;
          res.end(
            `${JSON.stringify({
              decision: { ok: true },
              relayed: true
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/handoff") {
          res.statusCode = 202;
          res.end(
            `${JSON.stringify({
              decision: { ok: true },
              relayed: true
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/revoke") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        res.statusCode = 404;
        res.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
      });
    });

    const relayPort = await listenOnLoopbackOrSkip(relayServer);
    if (typeof relayPort === "undefined") {
      return;
    }

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          },
          externalRelay: {
            enabled: true,
            host: "127.0.0.1",
            port: relayPort,
            authTokenEnvVar: "CODEFOX_EXTERNAL_RELAY_TOKEN"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [
            {
              chatId: 100,
              selectedRepo: "payments-api",
              mode: "active",
              updatedAt: "2026-03-14T12:00:00.000Z"
            }
          ],
          approvals: [],
          specWorkflows: [
            {
              chatId: 100,
              workflow: {
                revisions: [
                  {
                    version: 2,
                    stage: "approved",
                    status: "approved",
                    sourceIntent: "prepare branch",
                    createdAt: "2026-03-14T12:00:00.000Z",
                    updatedAt: "2026-03-14T12:00:03.000Z",
                    approvedAt: "2026-03-14T12:00:03.000Z",
                    sections: {
                      REQUEST: "prepare branch",
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
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousRelayToken = process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = relayToken;

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    let code = 1;
    try {
      code = await runLocalCli(
        [
          "--config",
          configPath,
          "handoff",
          "--completed",
          "Endpoint implemented",
          "--risk",
          "Need final green run"
        ],
        output
      );
    } finally {
      await closeServer(relayServer);
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      if (typeof previousRelayToken === "undefined") {
        delete process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
      } else {
        process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = previousRelayToken;
      }
    }

    expect(
      code,
      JSON.stringify(
        {
          logs,
          errors,
          requests: relayRequests.map((entry) => `${entry.method} ${entry.path}`)
        },
        null,
        2
      )
    ).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Handoff submitted successfully");
    expect(logs.join("\n")).toContain("Auto-selected session chat:100/repo:payments-api/mode:active");
    expect(logs.join("\n")).toContain("task id: TASK-");
    expect(logs.join("\n")).toContain("/accept");
    expect(logs.join("\n")).toContain("After acceptance, CodeFox can continue immediately.");

    expect(relayRequests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /v1/external-codex/routes",
      "POST /v1/external-codex/bind",
      "POST /v1/external-codex/event",
      "POST /v1/external-codex/handoff",
      "POST /v1/external-codex/revoke"
    ]);

    const bindBody = relayRequests[1]?.body;
    expect(bindBody?.session).toEqual({ sessionId: "chat:100/repo:payments-api/mode:active" });
    const handoffBody = relayRequests[3]?.body;
    expect(typeof handoffBody?.taskId).toBe("string");
    expect(String(handoffBody?.taskId)).toContain("TASK-");
    expect(handoffBody?.remainingWork).toEqual([
      {
        id: "rw-1",
        summary: "Continue remaining handoff work"
      }
    ]);
    expect(handoffBody?.sourceRepo).toEqual({ name: "payments-api" });
    expect(handoffBody?.specRevisionRef).toBe("v2");
  });

  it("fails handoff when relay accepts but does not deliver event/handoff to routed chat", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-handoff-unrouted-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const relayToken = "relay-test-token";
    const relayRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

    const relayServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      req.on("end", () => {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${relayToken}`) {
          res.statusCode = 401;
          res.end(`${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`);
          return;
        }
        const method = req.method ?? "GET";
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathName = requestUrl.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8").trim();
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        relayRequests.push({ method, path: pathName, body });

        if (method === "GET" && pathName === "/v1/external-codex/routes") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              routes: [{ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 }]
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/bind") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              lease: {
                leaseId: "lease_test_unrouted",
                schemaVersion: "v1",
                session: { sessionId: "chat:100/repo:payments-api/mode:active" }
              },
              manifest: {
                schemaVersion: "v1",
                capabilityClasses: ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
                maxLeaseSeconds: 600
              }
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/event") {
          res.statusCode = 202;
          res.end(
            `${JSON.stringify({
              decision: { ok: true },
              relayed: false
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/revoke") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/handoff") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ decision: { ok: true }, relayed: true })}\n`);
          return;
        }

        res.statusCode = 404;
        res.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
      });
    });

    const relayPort = await listenOnLoopbackOrSkip(relayServer);
    if (typeof relayPort === "undefined") {
      return;
    }

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          },
          externalRelay: {
            enabled: true,
            host: "127.0.0.1",
            port: relayPort,
            authTokenEnvVar: "CODEFOX_EXTERNAL_RELAY_TOKEN"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [
            {
              chatId: 100,
              selectedRepo: "payments-api",
              mode: "active",
              updatedAt: "2026-03-14T12:00:00.000Z"
            }
          ],
          approvals: [],
          specWorkflows: [
            {
              chatId: 100,
              workflow: {
                revisions: [
                  {
                    version: 2,
                    stage: "approved",
                    status: "approved",
                    sourceIntent: "prepare branch",
                    createdAt: "2026-03-14T12:00:00.000Z",
                    updatedAt: "2026-03-14T12:00:03.000Z",
                    approvedAt: "2026-03-14T12:00:03.000Z",
                    sections: {
                      REQUEST: "prepare branch",
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
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousRelayToken = process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = relayToken;

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    let code = 1;
    try {
      code = await runLocalCli(["--config", configPath, "handoff", "--repo-path", repoPath], output);
    } finally {
      await closeServer(relayServer);
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      if (typeof previousRelayToken === "undefined") {
        delete process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
      } else {
        process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = previousRelayToken;
      }
    }

    expect(code).toBe(1);
    expect(logs.join("\n")).not.toContain("Handoff submitted successfully");
    expect(errors.join("\n")).toContain("accepted but not delivered to a routed chat session");
    expect(relayRequests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /v1/external-codex/routes",
      "POST /v1/external-codex/bind",
      "POST /v1/external-codex/event",
      "POST /v1/external-codex/revoke"
    ]);
  });

  it("auto-bootstraps approved spec when none exists for handoff chat", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-handoff-autospec-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const relayToken = "relay-test-token";
    const relayRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

    const relayServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${relayToken}`) {
          res.statusCode = 401;
          res.end(`${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`);
          return;
        }
        const method = req.method ?? "GET";
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathName = requestUrl.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8").trim();
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        relayRequests.push({ method, path: pathName, body });

        if (method === "GET" && pathName === "/v1/external-codex/routes") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              routes: [{ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 }]
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/bind") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              lease: {
                leaseId: "lease_test_2",
                schemaVersion: "v1",
                session: { sessionId: "chat:100/repo:payments-api/mode:active" }
              },
              manifest: {
                schemaVersion: "v1",
                capabilityClasses: ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
                maxLeaseSeconds: 600
              }
            })}\n`
          );
          return;
        }
        if (method === "POST" && (pathName === "/v1/external-codex/event" || pathName === "/v1/external-codex/handoff")) {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ decision: { ok: true }, relayed: true })}\n`);
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/revoke") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        res.statusCode = 404;
        res.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
      });
    });

    const relayPort = await listenOnLoopbackOrSkip(relayServer);
    if (typeof relayPort === "undefined") {
      return;
    }

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          },
          externalRelay: {
            enabled: true,
            host: "127.0.0.1",
            port: relayPort,
            authTokenEnvVar: "CODEFOX_EXTERNAL_RELAY_TOKEN"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [
            {
              chatId: 100,
              selectedRepo: "payments-api",
              mode: "active",
              activeRequestId: "req_auto",
              updatedAt: "2026-03-14T12:00:00.000Z"
            }
          ],
          approvals: [],
          specWorkflows: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousRelayToken = process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = relayToken;

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    let code = 1;
    try {
      code = await runLocalCli(["--config", configPath, "handoff", "--repo-path", repoPath], output);
    } finally {
      await closeServer(relayServer);
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      if (typeof previousRelayToken === "undefined") {
        delete process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
      } else {
        process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = previousRelayToken;
      }
    }

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Auto-created and approved spec v1 for chat 100.");

    const handoffBody = relayRequests.find((request) => request.path === "/v1/external-codex/handoff")?.body;
    expect(handoffBody?.specRevisionRef).toBe("v1");

    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      specWorkflows?: Array<{ chatId: number; workflow: { revisions: Array<{ version: number; status: string; stage: string }> } }>;
    };
    expect(persisted.specWorkflows?.length).toBe(1);
    expect(persisted.specWorkflows?.[0]?.chatId).toBe(100);
    expect(persisted.specWorkflows?.[0]?.workflow.revisions.at(-1)?.status).toBe("approved");
  });

  it("resolves explicit chat handoff using active relay routes when persisted session is missing", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-handoff-route-chat-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const relayToken = "relay-test-token";
    const relayRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

    const relayServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${relayToken}`) {
          res.statusCode = 401;
          res.end(`${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`);
          return;
        }
        const method = req.method ?? "GET";
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathName = requestUrl.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8").trim();
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        relayRequests.push({ method, path: pathName, body });

        if (method === "GET" && pathName === "/v1/external-codex/routes") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              routes: [{ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 }]
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/bind") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              lease: {
                leaseId: "lease_test_route_chat",
                schemaVersion: "v1",
                session: { sessionId: "chat:100/repo:payments-api/mode:active" }
              },
              manifest: {
                schemaVersion: "v1",
                capabilityClasses: ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
                maxLeaseSeconds: 600
              }
            })}\n`
          );
          return;
        }
        if (method === "POST" && (pathName === "/v1/external-codex/event" || pathName === "/v1/external-codex/handoff")) {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ decision: { ok: true }, relayed: true })}\n`);
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/revoke") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        res.statusCode = 404;
        res.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
      });
    });

    const relayPort = await listenOnLoopbackOrSkip(relayServer);
    if (typeof relayPort === "undefined") {
      return;
    }

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          },
          externalRelay: {
            enabled: true,
            host: "127.0.0.1",
            port: relayPort,
            authTokenEnvVar: "CODEFOX_EXTERNAL_RELAY_TOKEN"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [],
          approvals: [],
          specWorkflows: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousRelayToken = process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = relayToken;

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    let code = 1;
    try {
      code = await runLocalCli(["--config", configPath, "handoff", "100"], output);
    } finally {
      await closeServer(relayServer);
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      if (typeof previousRelayToken === "undefined") {
        delete process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
      } else {
        process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = previousRelayToken;
      }
    }

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Auto-selected session chat:100/repo:payments-api/mode:active");
    const bindBody = relayRequests.find((request) => request.path === "/v1/external-codex/bind")?.body;
    expect(bindBody?.session).toEqual({ sessionId: "chat:100/repo:payments-api/mode:active" });
  });

  it("re-sends repeated equivalent handoff to re-notify routed clients", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-handoff-idempotent-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const relayToken = "relay-test-token";
    const relayRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

    const relayServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${relayToken}`) {
          res.statusCode = 401;
          res.end(`${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`);
          return;
        }
        const method = req.method ?? "GET";
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathName = requestUrl.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8").trim();
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        relayRequests.push({ method, path: pathName, body });

        if (method === "GET" && pathName === "/v1/external-codex/routes") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              routes: [{ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 }]
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/bind") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              lease: {
                leaseId: "lease_reminder",
                schemaVersion: "v1",
                session: { sessionId: "chat:100/repo:payments-api/mode:active" }
              },
              manifest: {
                schemaVersion: "v1",
                capabilityClasses: ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
                maxLeaseSeconds: 600
              }
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/handoff") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ decision: { ok: true }, relayed: true })}\n`);
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/revoke") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        res.statusCode = 404;
        res.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
      });
    });

    const relayPort = await listenOnLoopbackOrSkip(relayServer);
    if (typeof relayPort === "undefined") {
      return;
    }

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          },
          externalRelay: {
            enabled: true,
            host: "127.0.0.1",
            port: relayPort,
            authTokenEnvVar: "CODEFOX_EXTERNAL_RELAY_TOKEN"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [
            {
              chatId: 100,
              selectedRepo: "payments-api",
              mode: "active",
              updatedAt: "2026-03-14T12:00:00.000Z"
            }
          ],
          approvals: [],
          specWorkflows: [
            {
              chatId: 100,
              workflow: {
                revisions: [
                  {
                    version: 1,
                    stage: "approved",
                    status: "approved",
                    sourceIntent: "continue work",
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
          ],
          externalHandoffs: [
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
                clientId: "codex-handoff-cli",
                createdAt: "2026-03-14T12:01:00.000Z",
                taskId: "TASK-EXISTING",
                specRevisionRef: "v1",
                completedWork: [],
                remainingWork: [
                  {
                    id: "rw-1",
                    summary: "Continue remaining handoff work"
                  }
                ],
                sourceRepo: {
                  name: "payments-api"
                }
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousRelayToken = process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = relayToken;

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    let code = 1;
    try {
      code = await runLocalCli(["--config", configPath, "handoff", "--repo-path", repoPath], output);
    } finally {
      await closeServer(relayServer);
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      if (typeof previousRelayToken === "undefined") {
        delete process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
      } else {
        process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = previousRelayToken;
      }
    }

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Handoff already up to date for chat 100; re-sending reminder");
    expect(logs.join("\n")).toContain("Handoff reminder submitted successfully for chat 100.");
    expect(relayRequests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /v1/external-codex/routes",
      "POST /v1/external-codex/bind",
      "POST /v1/external-codex/handoff",
      "POST /v1/external-codex/revoke"
    ]);
  });

  it("re-sends equivalent actionable handoff to re-notify routed clients", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-handoff-reminder-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const relayToken = "relay-test-token";
    const relayRequests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

    const relayServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const auth = req.headers.authorization ?? "";
        if (auth !== `Bearer ${relayToken}`) {
          res.statusCode = 401;
          res.end(`${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`);
          return;
        }
        const method = req.method ?? "GET";
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathName = requestUrl.pathname;
        const rawBody = Buffer.concat(chunks).toString("utf8").trim();
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        relayRequests.push({ method, path: pathName, body });

        if (method === "GET" && pathName === "/v1/external-codex/routes") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              routes: [{ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 }]
            })}\n`
          );
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/bind") {
          res.statusCode = 200;
          res.end(
            `${JSON.stringify({
              ok: true,
              lease: {
                leaseId: "lease_reminder",
                schemaVersion: "v1",
                session: { sessionId: "chat:100/repo:payments-api/mode:active" }
              },
              manifest: {
                schemaVersion: "v1",
                capabilityClasses: ["progress", "blocker", "approval_request", "completion", "handoff_bundle"],
                maxLeaseSeconds: 600
              }
            })}\n`
          );
          return;
        }
        if (method === "POST" && (pathName === "/v1/external-codex/event" || pathName === "/v1/external-codex/handoff")) {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ decision: { ok: true }, relayed: true })}\n`);
          return;
        }
        if (method === "POST" && pathName === "/v1/external-codex/revoke") {
          res.statusCode = 202;
          res.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        res.statusCode = 404;
        res.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
      });
    });

    const relayPort = await listenOnLoopbackOrSkip(relayServer);
    if (typeof relayPort === "undefined") {
      return;
    }

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [7],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          },
          externalRelay: {
            enabled: true,
            host: "127.0.0.1",
            port: relayPort,
            authTokenEnvVar: "CODEFOX_EXTERNAL_RELAY_TOKEN"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [
            {
              chatId: 100,
              selectedRepo: "payments-api",
              mode: "active",
              updatedAt: "2026-03-14T12:00:00.000Z"
            }
          ],
          approvals: [],
          specWorkflows: [
            {
              chatId: 100,
              workflow: {
                revisions: [
                  {
                    version: 1,
                    stage: "approved",
                    status: "approved",
                    sourceIntent: "continue work",
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
          ],
          externalHandoffs: [
            {
              chatId: 100,
              leaseId: "lease_existing",
              sourceSessionId: "chat:100/repo:payments-api/mode:active",
              sourceRepoName: "payments-api",
              sourceMode: "active",
              receivedAt: "2026-03-14T12:01:00.000Z",
              continuedWorkIds: [],
              awaitingConfirmation: true,
              awaitingExternalCompletion: true,
              externalCompletionStatus: "pending",
              handoff: {
                schemaVersion: "v1",
                leaseId: "lease_existing",
                handoffId: "handoff_existing",
                clientId: "codex-handoff-cli",
                createdAt: "2026-03-14T12:01:00.000Z",
                taskId: "TASK-EXISTING",
                specRevisionRef: "v1",
                completedWork: [],
                remainingWork: [
                  {
                    id: "rw-1",
                    summary: "Continue remaining handoff work"
                  }
                ],
                sourceRepo: {
                  name: "payments-api"
                }
              }
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousRelayToken = process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = relayToken;

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };

    let code = 1;
    try {
      code = await runLocalCli(["--config", configPath, "handoff"], output);
    } finally {
      await closeServer(relayServer);
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      if (typeof previousRelayToken === "undefined") {
        delete process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
      } else {
        process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = previousRelayToken;
      }
    }

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("Handoff already up to date for chat 100; re-sending reminder");
    expect(logs.join("\n")).toContain("Handoff reminder submitted successfully for chat 100.");
    expect(relayRequests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /v1/external-codex/routes",
      "POST /v1/external-codex/bind",
      "POST /v1/external-codex/handoff",
      "POST /v1/external-codex/revoke"
    ]);
  });

  it("stops background CodeFox process using pid file", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-stop-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const pidFilePath = path.join(path.dirname(statePath), "codefox.dev.pid");

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [1],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [],
          approvals: [],
          specWorkflows: [],
          externalHandoffs: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const background = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000);", "codefox", "src/index.ts"],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    background.unref();
    expect(typeof background.pid).toBe("number");
    const pid = background.pid as number;
    await writeFile(pidFilePath, `${pid}\n`, "utf8");

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    try {
      const code = await runLocalCli(["--config", configPath, "stop"], output);
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      expect(logs.join("\n")).toContain(`Stopped background CodeFox process pid ${pid}.`);
    } finally {
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  });

  it("stops background CodeFox process by config scan when pid file is stale", async () => {
    if (process.platform !== "linux") {
      return;
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-cli-stop-fallback-"));
    const repoPath = path.join(tmpDir, "repo");
    const configPath = path.join(tmpDir, "codefox.config.json");
    const statePath = path.join(tmpDir, "state.json");
    const pidFilePath = path.join(path.dirname(statePath), "codefox.dev.pid");

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          telegram: {
            token: "dummy",
            allowedUserIds: [1],
            allowedChatIds: [100],
            pollingTimeoutSeconds: 30,
            pollIntervalMs: 1000,
            discardBacklogOnStart: true
          },
          repos: [{ name: "payments-api", rootPath: repoPath }],
          codex: {
            command: "codex",
            baseArgs: ["exec"],
            runArgTemplate: ["{instruction}"],
            repoArgTemplate: [],
            timeoutMs: 60000,
            blockedEnvVars: [],
            preflightEnabled: false,
            preflightArgs: ["--version"],
            preflightTimeoutMs: 1000
          },
          policy: {
            defaultMode: "observe"
          },
          safety: {
            requireAgentsForRuns: false,
            instructionPolicy: {
              blockedPatterns: [],
              allowedDownloadDomains: [],
              forbiddenPathPatterns: []
            }
          },
          repoInit: {
            defaultParentPath: tmpDir
          },
          state: {
            filePath: statePath,
            codexSessionIdleMinutes: 120
          },
          audit: {
            logFilePath: path.join(tmpDir, "audit.log")
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          sessions: [],
          approvals: [],
          specWorkflows: [],
          externalHandoffs: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const background = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000);", "src/index.ts", path.resolve(configPath)],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    background.unref();
    const pid = background.pid as number;
    await writeFile(pidFilePath, "999999\n", "utf8");

    const logs: string[] = [];
    const errors: string[] = [];
    const output = {
      log(line: string) {
        logs.push(line);
      },
      error(line: string) {
        errors.push(line);
      }
    };
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";

    try {
      const code = await runLocalCli(["--config", configPath, "stop"], output);
      expect(code).toBe(0);
      expect(errors).toEqual([]);
      expect(logs.join("\n")).toContain("Removed stale pid file");
      expect(logs.join("\n")).toContain(`Stopped background CodeFox process pid ${pid}.`);
    } finally {
      if (typeof previousToken === "undefined") {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  });
});
