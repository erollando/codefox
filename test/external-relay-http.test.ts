import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_CODEX_SCHEMA_VERSION,
  ExternalCodexIntegration
} from "../src/core/external-codex-integration.js";
import { ExternalCodexRelay } from "../src/core/external-codex-relay.js";
import { ExternalRelayHttpServer } from "../src/adapters/external-relay-http.js";

describe("ExternalRelayHttpServer", () => {
  const servers: ExternalRelayHttpServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.stop();
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
    servers.push(server);

    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;

    const bindResponse = await fetch(`${base}/v1/external-codex/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "vscode-codex",
        session: { sessionId: "chat:100/repo:payments-api/mode:active" },
        requestedSchemaVersion: EXTERNAL_CODEX_SCHEMA_VERSION,
        requestedCapabilityClasses: ["progress", "completion", "handoff_bundle"]
      })
    });

    expect(bindResponse.status).toBe(200);
    const bindBody = (await bindResponse.json()) as { ok: boolean; lease?: { leaseId: string } };
    expect(bindBody.ok).toBe(true);
    const leaseId = bindBody.lease?.leaseId;
    expect(leaseId).toBeDefined();

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
    expect(notifications.length).toBe(2);
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
    servers.push(server);

    const address = await server.start();
    const base = `http://${address.host}:${address.port}`;

    const unauthorized = await fetch(`${base}/health`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${base}/health`, {
      headers: {
        authorization: "Bearer secret-token"
      }
    });
    expect(authorized.status).toBe(200);
  });
});
