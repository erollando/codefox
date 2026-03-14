import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_CODEX_SCHEMA_VERSION,
  ExternalCodexIntegration
} from "../src/core/external-codex-integration.js";
import { ExternalCodexRelay } from "../src/core/external-codex-relay.js";
import { ExternalRelayHttpServer } from "../src/adapters/external-relay-http.js";

function isLoopbackPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = Reflect.get(error, "code");
  return code === "EPERM" || code === "EACCES";
}

async function startServerOrSkip(server: ExternalRelayHttpServer) {
  try {
    return await server.start();
  } catch (error) {
    if (isLoopbackPermissionError(error)) {
      return undefined;
    }
    throw error;
  }
}

describe("ExternalRelayHttpServer", () => {
  const servers: ExternalRelayHttpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        try {
          await server.stop();
        } catch (error) {
          if (error instanceof Error && error.message.includes("Server is not running")) {
            continue;
          }
          throw error;
        }
      }
    }
  });

  it("supports bind/event/handoff HTTP flow", async () => {
    const notifications: Array<{ chatId: number; message: string }> = [];
    const relay = new ExternalCodexRelay({
      integration: new ExternalCodexIntegration(),
      audit: { async log() {} },
      notify: async (chatId, message) => {
        notifications.push({ chatId, message });
      }
    });

    const server = new ExternalRelayHttpServer({
      relay,
      host: "127.0.0.1",
      port: 0,
      getRoutes: () => [{ sessionId: "chat:100/repo:payments-api/mode:active", chatId: 100 }]
    });
    const address = await startServerOrSkip(server);
    if (!address) {
      return;
    }
    servers.push(server);
    const base = `http://${address.host}:${address.port}`;

    const bindResponse = await fetch(`${base}/v1/external-codex/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "vscode-codex",
        session: { sessionId: "chat:100/repo:payments-api/mode:active" },
        requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        requestedCapabilityClasses: ["progress", "approval_request", "completion", "handoff_bundle"]
      })
    });

    expect(bindResponse.status).toBe(200);
    const bindBody = (await bindResponse.json()) as { ok: boolean; lease?: { leaseId: string } };
    expect(bindBody.ok).toBe(true);
    const leaseId = bindBody.lease?.leaseId;
    expect(leaseId).toBeDefined();

    const secondBindResponse = await fetch(`${base}/v1/external-codex/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "vscode-codex-2",
        session: { sessionId: "chat:100/repo:payments-api/mode:active" },
        requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        requestedCapabilityClasses: ["progress"]
      })
    });
    expect(secondBindResponse.status).toBe(400);
    const secondBindBody = (await secondBindResponse.json()) as { ok: boolean; reasonCode?: string };
    expect(secondBindBody.ok).toBe(false);
    expect(secondBindBody.reasonCode).toBe("session_already_bound");

    const eventResponse = await fetch(`${base}/v1/external-codex/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        leaseId,
        eventId: "evt-1",
        clientId: "vscode-codex",
        timestamp: "2026-03-14T12:00:00.000Z",
        sequence: 1,
        type: "progress",
        summary: "Running checks",
        progressPercent: 20
      })
    });

    expect(eventResponse.status).toBe(202);
    const eventBody = (await eventResponse.json()) as { decision: { ok: boolean }; relayed: boolean };
    expect(eventBody.decision.ok).toBe(true);
    expect(eventBody.relayed).toBe(true);

    const heartbeatResponse = await fetch(`${base}/v1/external-codex/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId })
    });
    expect(heartbeatResponse.status).toBe(202);

    const approvalEventResponse = await fetch(`${base}/v1/external-codex/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        leaseId,
        eventId: "evt-2",
        clientId: "vscode-codex",
        timestamp: "2026-03-14T12:00:06.000Z",
        sequence: 2,
        type: "approval_request",
        summary: "Need approval to push",
        approvalKey: "push-branch",
        requestedCapabilityRef: "repo.prepare_branch"
      })
    });
    expect(approvalEventResponse.status).toBe(202);

    const approvalQuery = await fetch(`${base}/v1/external-codex/approval?leaseId=${leaseId}&approvalKey=push-branch`);
    expect(approvalQuery.status).toBe(200);
    const approvalBody = (await approvalQuery.json()) as { ok: boolean; approval?: { status: string } };
    expect(approvalBody.ok).toBe(true);
    expect(approvalBody.approval?.status).toBe("pending");

    const handoffResponse = await fetch(`${base}/v1/external-codex/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        leaseId,
        handoffId: "handoff-1",
        clientId: "vscode-codex",
        createdAt: "2026-03-14T12:00:10.000Z",
        taskId: "TASK-100",
        specRevisionRef: "v3",
        completedWork: ["implemented endpoint"],
        remainingWork: [{ id: "rw-1", summary: "monitor rollout" }]
      })
    });

    expect(handoffResponse.status).toBe(202);
    const handoffBody = (await handoffResponse.json()) as { decision: { ok: boolean }; relayed: boolean };
    expect(handoffBody.decision.ok).toBe(true);
    expect(handoffBody.relayed).toBe(true);
    expect(notifications.length).toBe(3);

    const revokeResponse = await fetch(`${base}/v1/external-codex/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseId,
        reason: "done"
      })
    });
    expect(revokeResponse.status).toBe(202);

    const heartbeatAfterRevoke = await fetch(`${base}/v1/external-codex/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId })
    });
    expect(heartbeatAfterRevoke.status).toBe(404);
  });

  it("enforces auth token when configured", async () => {
    const relay = new ExternalCodexRelay({
      integration: new ExternalCodexIntegration(),
      audit: { async log() {} },
      notify: async () => {}
    });

    const server = new ExternalRelayHttpServer({
      relay,
      host: "127.0.0.1",
      port: 0,
      authToken: "secret-token",
      getRoutes: () => []
    });
    const address = await startServerOrSkip(server);
    if (!address) {
      return;
    }
    servers.push(server);
    const base = `http://${address.host}:${address.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    const unauthorizedRoutes = await fetch(`${base}/v1/external-codex/routes`);
    expect(unauthorizedRoutes.status).toBe(401);

    const authorized = await fetch(`${base}/health`, {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    expect(authorized.status).toBe(200);
  });
});
