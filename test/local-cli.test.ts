import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";

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

  it("parses chat command with optional chatId", () => {
    const parsedWithChat = parseLocalCliArgs(["--user", "9", "chat", "100"]);
    expect(parsedWithChat.ok).toBe(true);
    if (!parsedWithChat.ok || !parsedWithChat.args) {
      return;
    }
    expect(parsedWithChat.args.command).toBe("chat");
    expect(parsedWithChat.args.chatId).toBe(100);
    expect(parsedWithChat.args.userId).toBe(9);

    const parsedWithoutChat = parseLocalCliArgs(["chat"]);
    expect(parsedWithoutChat.ok).toBe(true);
    if (!parsedWithoutChat.ok || !parsedWithoutChat.args) {
      return;
    }
    expect(parsedWithoutChat.args.command).toBe("chat");
    expect(parsedWithoutChat.args.chatId).toBeUndefined();
  });

  it("parses local shortcut commands", () => {
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

    const handoffStatus = parseLocalCliArgs(["handoff-status"]);
    expect(handoffStatus.ok).toBe(true);
    if (!handoffStatus.ok || !handoffStatus.args) {
      return;
    }
    expect(handoffStatus.args.command).toBe("handoff-status");
    expect(handoffStatus.args.chatId).toBeUndefined();

    const handoffShow = parseLocalCliArgs(["handoff-show", "100"]);
    expect(handoffShow.ok).toBe(true);
    if (!handoffShow.ok || !handoffShow.args) {
      return;
    }
    expect(handoffShow.args.command).toBe("handoff-show");
    expect(handoffShow.args.chatId).toBe(100);

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
      "--start-if-missing"
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
    let approvalsExit = 0;
    let specsExit = 0;
    let sessionExit = 0;
    try {
      sessionsExit = await runLocalCli(["--config", configPath, "sessions"], output);
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
    expect(approvalsExit).toBe(0);
    expect(specsExit).toBe(0);
    expect(sessionExit).toBe(0);
    expect(errors).toEqual([]);

    const rendered = logs.join("\n\n");
    expect(rendered).toContain("Sessions:");
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
      const handoffStatusCode = await runLocalCli(["--config", configPath, "handoff-status"], output);
      const handoffShowCode = await runLocalCli(["--config", configPath, "handoff-show"], output);
      const continueCode = await runLocalCli(["--config", configPath, "continue", "rw-1"], output);
      expect(approveCode).toBe(0);
      expect(statusCode).toBe(0);
      expect(handoffStatusCode).toBe(0);
      expect(handoffShowCode).toBe(0);
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
    expect(rendered).toContain(": /handoff status");
    expect(rendered).toContain(": /handoff show");
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

    await new Promise<void>((resolve) => {
      relayServer.listen(0, "127.0.0.1", () => resolve());
    });
    const relayAddress = relayServer.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;

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
      await new Promise<void>((resolve, reject) => {
        relayServer.close((error) => (error ? reject(error) : resolve()));
      });
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
    expect(logs.join("\n")).toContain("Handoff submitted successfully");
    expect(logs.join("\n")).toContain("Auto-selected session chat:100/repo:payments-api/mode:active");
    expect(logs.join("\n")).toContain("task id: TASK-");
    expect(logs.join("\n")).toContain("/continue rw-1");

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

    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", () => resolve()));
    const relayAddress = relayServer.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;

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
      code = await runLocalCli(["--config", configPath, "handoff"], output);
    } finally {
      await new Promise<void>((resolve, reject) => relayServer.close((error) => (error ? reject(error) : resolve())));
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

    await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", () => resolve()));
    const relayAddress = relayServer.address();
    const relayPort = typeof relayAddress === "object" && relayAddress ? relayAddress.port : 0;

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
      await new Promise<void>((resolve, reject) => relayServer.close((error) => (error ? reject(error) : resolve())));
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
});
