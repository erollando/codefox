import { mkdtemp, writeFile } from "node:fs/promises";
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

  it("returns parse errors for invalid session command", () => {
    const missing = parseLocalCliArgs(["session"]);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("requires <chatId>");

    const invalid = parseLocalCliArgs(["session", "abc"]);
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("positive integer");
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
});
