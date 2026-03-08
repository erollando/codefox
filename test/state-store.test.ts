import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JsonStateStore, pruneStateByTtl } from "../src/core/state-store.js";

describe("JsonStateStore", () => {
  it("returns empty state when file does not exist", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-state-"));
    const store = new JsonStateStore(path.join(tmpDir, "missing.json"));

    const loaded = await store.load();
    expect(loaded.sessions).toEqual([]);
    expect(loaded.approvals).toEqual([]);
  });

  it("saves and reloads sessions/approvals", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-state-"));
    const statePath = path.join(tmpDir, "state.json");
    const store = new JsonStateStore(statePath);

    await store.save({
      sessions: [
        {
          chatId: 100,
          mode: "active",
          selectedRepo: "payments-api",
          activeRequestId: "abc",
          codexThreadId: "thread_1",
          codexLastActiveAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      approvals: [
        {
          id: "req-1",
          chatId: 100,
          userId: 1,
          repoName: "payments-api",
          mode: "active",
          instruction: "fix tests",
          createdAt: new Date().toISOString()
        }
      ]
    });

    const loaded = await store.load();
    expect(loaded.sessions.length).toBe(1);
    expect(loaded.approvals.length).toBe(1);
    expect(loaded.sessions[0].selectedRepo).toBe("payments-api");
    expect(loaded.sessions[0].codexThreadId).toBe("thread_1");
    expect(typeof loaded.sessions[0].updatedAt).toBe("string");

    const raw = await readFile(statePath, "utf8");
    expect(raw).toContain("payments-api");
  });

  it("sanitizes malformed state on load", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-state-"));
    const statePath = path.join(tmpDir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        sessions: [{ chatId: "bad", mode: "active" }, { chatId: 1, mode: "observe", codexThreadId: 2 }],
        approvals: [{ id: "x", chatId: "bad" }]
      }),
      "utf8"
    );

    const store = new JsonStateStore(statePath);
    const loaded = await store.load();

    expect(loaded.sessions).toEqual([
      {
        chatId: 1,
        mode: "observe",
        selectedRepo: undefined,
        activeRequestId: undefined,
        codexThreadId: undefined,
        codexLastActiveAt: undefined,
        updatedAt: expect.any(String)
      }
    ]);
    expect(loaded.approvals).toEqual([]);
  });

  it("prunes stale sessions and approvals when TTL is set", () => {
    const now = new Date("2026-01-02T12:00:00.000Z");
    const result = pruneStateByTtl(
      {
        sessions: [
          {
            chatId: 100,
            mode: "active",
            updatedAt: "2026-01-02T11:30:00.000Z"
          },
          {
            chatId: 200,
            mode: "active",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ],
        approvals: [
          {
            id: "fresh",
            chatId: 100,
            userId: 1,
            repoName: "payments-api",
            mode: "active",
            instruction: "fix tests",
            createdAt: "2026-01-02T11:45:00.000Z"
          },
          {
            id: "stale",
            chatId: 200,
            userId: 1,
            repoName: "payments-api",
            mode: "active",
            instruction: "fix tests",
            createdAt: "2025-12-30T11:45:00.000Z"
          }
        ]
      },
      {
        sessionTtlHours: 2,
        approvalTtlHours: 24
      },
      now
    );

    expect(result.state.sessions.map((session) => session.chatId)).toEqual([100]);
    expect(result.state.approvals.map((approval) => approval.id)).toEqual(["fresh"]);
    expect(result.removedSessions).toBe(1);
    expect(result.removedApprovals).toBe(1);
  });
});
