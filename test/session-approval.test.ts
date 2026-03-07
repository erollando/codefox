import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import { ApprovalStore } from "../src/core/approval-store.js";

describe("SessionManager", () => {
  it("tracks repo/mode/active request per chat", () => {
    const sessions = new SessionManager("observe");

    sessions.setRepo(100, "payments-api");
    sessions.setMode(100, "active");
    sessions.setActiveRequest(100, "abc123");

    const session = sessions.getOrCreate(100);
    expect(session).toMatchObject({
      chatId: 100,
      selectedRepo: "payments-api",
      mode: "active",
      activeRequestId: "abc123"
    });
    expect(typeof session.updatedAt).toBe("string");
  });
});

describe("ApprovalStore", () => {
  it("stores and deletes pending approvals by chat", () => {
    const store = new ApprovalStore();

    store.set({
      id: "req-1",
      chatId: 100,
      userId: 1,
      repoName: "payments-api",
      mode: "active",
      taskType: "task",
      instruction: "fix tests",
      createdAt: new Date().toISOString()
    });

    expect(store.get(100)?.id).toBe("req-1");
    store.delete(100);
    expect(store.get(100)).toBeUndefined();
  });
});
