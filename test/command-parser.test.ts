import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/core/command-parser.js";

describe("parseCommand", () => {
  it("parses slash commands", () => {
    expect(parseCommand("/help", "task")).toEqual({ type: "help" });
    expect(parseCommand("/help@codefox_bot", "task")).toEqual({ type: "help" });
    expect(parseCommand("/repo payments-api", "task")).toEqual({
      type: "repo",
      repoName: "payments-api"
    });
    expect(parseCommand("/repo add pii-api /tmp/work/pii-api", "task")).toEqual({
      type: "repo_add",
      repoName: "pii-api",
      repoPath: "/tmp/work/pii-api"
    });
    expect(parseCommand("/repo init pii-api", "task")).toEqual({
      type: "repo_init",
      repoName: "pii-api",
      basePath: undefined
    });
    expect(parseCommand("/repo init pii-api /tmp/work", "task")).toEqual({
      type: "repo_init",
      repoName: "pii-api",
      basePath: "/tmp/work"
    });
    expect(parseCommand("/repo remove pii-api", "task")).toEqual({
      type: "repo_remove",
      repoName: "pii-api"
    });
    expect(parseCommand("/repo info", "task")).toEqual({
      type: "repo_info",
      repoName: undefined
    });
    expect(parseCommand("/repo info pii-api", "task")).toEqual({
      type: "repo_info",
      repoName: "pii-api"
    });
    expect(parseCommand("/mode active", "task")).toEqual({
      type: "mode",
      mode: "active"
    });
    expect(parseCommand("/task@codefox_bot fix tests", "task")).toEqual({
      type: "task",
      instruction: "fix tests"
    });
    expect(parseCommand("/task fix tests", "task")).toEqual({
      type: "task",
      instruction: "fix tests"
    });
    expect(parseCommand("/pending", "task")).toEqual({ type: "pending" });
  });

  it("maps plain text by configured mode", () => {
    expect(parseCommand("fix failing build", "task")).toEqual({
      type: "task",
      instruction: "fix failing build"
    });
    expect(parseCommand("why is test failing?", "ask")).toEqual({
      type: "ask",
      instruction: "why is test failing?"
    });
  });

  it("returns unknown for malformed inputs", () => {
    expect(parseCommand("/mode invalid", "task").type).toBe("unknown");
    expect(parseCommand("/repo", "task").type).toBe("unknown");
    expect(parseCommand("/repo add only-name", "task").type).toBe("unknown");
    expect(parseCommand("/repo init", "task").type).toBe("unknown");
    expect(parseCommand("/repo remove", "task").type).toBe("unknown");
  });
});
