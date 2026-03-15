import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLocalCli } from "../src/core/local-cli.js";

interface RelayRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

async function listenOnLoopback(): Promise<{
  close: () => Promise<void>;
  port: number;
  requests: RelayRequest[];
}> {
  const requests: RelayRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      if (auth !== "Bearer relay-demo-token") {
        res.statusCode = 401;
        res.end(`${JSON.stringify({ ok: false, error: "Unauthorized" })}\n`);
        return;
      }

      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathName = requestUrl.pathname;
      const rawBody = Buffer.concat(chunks).toString("utf8").trim();
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
      requests.push({ method, path: pathName, body });

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
              leaseId: "lease_demo_cli",
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

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected numeric relay address.");
  }

  return {
    port: address.port,
    requests,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

async function runDemo(): Promise<void> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-demo-handoff-cli-"));
  const repoPath = path.join(tmpDir, "payments-api");
  const configPath = path.join(tmpDir, "codefox.config.json");
  const statePath = path.join(tmpDir, "state.json");
  const relay = await listenOnLoopback();

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
          port: relay.port,
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
            activeRequestId: "req_demo_cli",
            updatedAt: "2026-03-15T14:00:00.000Z"
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
                  sourceIntent: "finalize invoice export and regression checks",
                  createdAt: "2026-03-15T13:50:00.000Z",
                  updatedAt: "2026-03-15T13:58:00.000Z",
                  approvedAt: "2026-03-15T13:58:00.000Z",
                  sections: {
                    REQUEST: "finalize invoice export and regression checks",
                    GOAL: "Ship the export safely.",
                    OUTCOME: "Invoice export is ready for release.",
                    CONSTRAINTS: ["Keep schema unchanged."],
                    NON_GOALS: [],
                    CONTEXT: [],
                    ASSUMPTIONS: [],
                    QUESTIONS: [],
                    PLAN: ["Run final checks."],
                    APPROVALS_REQUIRED: [],
                    DONE_WHEN: ["Checks are green."]
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
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousRelayToken = process.env.CODEFOX_EXTERNAL_RELAY_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.CODEFOX_EXTERNAL_RELAY_TOKEN = "relay-demo-token";

  let exitCode = 1;
  try {
    exitCode = await runLocalCli(
      [
        "--config",
        configPath,
        "handoff",
        "--completed",
        "API endpoint added",
        "--completed",
        "Unit tests updated",
        "--remaining",
        "Run full regression checks before release",
        "--repo-path",
        repoPath,
        "--risk",
        "Need final green regression suite before release"
      ],
      {
        log(line) {
          logs.push(line);
        },
        error(line) {
          errors.push(line);
        }
      }
    );
  } finally {
    await relay.close();
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

  const handoffRequest = relay.requests.find((request) => request.path === "/v1/external-codex/handoff");
  const handoffBody = handoffRequest?.body;

  console.log("=== CodeFox Demo: Desk-side handoff CLI ===");
  console.log(`exit code: ${exitCode}`);
  console.log("note: this demo shows the desk terminal action itself. For the accept/wait/auto-continue lifecycle, run npm run demo:remote-handoff-lifecycle.");
  console.log("");
  console.log("=== Desk Command ===");
  console.log(
    'npm run handoff:cli -- --config ./config/codefox.config.json --completed "API endpoint added" --completed "Unit tests updated" --remaining "Run full regression checks before release" --repo-path /path/to/payments-api --risk "Need final green regression suite before release"'
  );
  console.log("");
  console.log("=== Desk Terminal Output ===");
  [...logs, ...errors.map((line) => `ERROR: ${line}`)].forEach((line, index) => {
    console.log(`${String(index + 1).padStart(2, "0")}. ${line}`);
  });
  console.log("");
  console.log("=== Relay Calls ===");
  relay.requests.forEach((request, index) => {
    console.log(`${String(index + 1).padStart(2, "0")}. ${request.method} ${request.path}`);
  });
  if (handoffBody) {
    console.log("");
    console.log("=== Submitted Handoff Summary ===");
    console.log(`task id: ${String(handoffBody.taskId ?? "unknown")}`);
    console.log(`spec ref: ${String(handoffBody.specRevisionRef ?? "unknown")}`);
    console.log(`remaining work: ${String((handoffBody.remainingWork as Array<{ summary?: string }> | undefined)?.[0]?.summary ?? "unknown")}`);
  }
}

void runDemo().catch((error) => {
  console.error(`Demo failed: ${String(error)}`);
  process.exitCode = 1;
});
