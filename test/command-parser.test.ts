import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/core/command-parser.js";

describe("parseCommand", () => {
  it("parses slash commands", () => {
    expect(parseCommand("/help")).toEqual({ type: "help" });
    expect(parseCommand("/help@codefox_bot")).toEqual({ type: "help" });
    expect(parseCommand("/repo payments-api")).toEqual({
      type: "repo",
      repoName: "payments-api"
    });
    expect(parseCommand("/repo add pii-api /tmp/work/pii-api")).toEqual({
      type: "repo_add",
      repoName: "pii-api",
      repoPath: "/tmp/work/pii-api"
    });
    expect(parseCommand("/repo init pii-api")).toEqual({
      type: "repo_init",
      repoName: "pii-api",
      basePath: undefined
    });
    expect(parseCommand("/repo init pii-api /tmp/work")).toEqual({
      type: "repo_init",
      repoName: "pii-api",
      basePath: "/tmp/work"
    });
    expect(parseCommand("/repo remove pii-api")).toEqual({
      type: "repo_remove",
      repoName: "pii-api"
    });
    expect(parseCommand("/repo info")).toEqual({
      type: "repo_info",
      repoName: undefined
    });
    expect(parseCommand("/repo info pii-api")).toEqual({
      type: "repo_info",
      repoName: "pii-api"
    });
    expect(parseCommand("/mode active")).toEqual({
      type: "mode",
      mode: "active"
    });
    expect(parseCommand("/observe")).toEqual({
      type: "mode",
      mode: "observe"
    });
    expect(parseCommand("/run@codefox_bot fix tests")).toEqual({
      type: "run",
      instruction: "fix tests"
    });
    expect(parseCommand("/steer use a smaller patch")).toEqual({
      type: "steer",
      instruction: "use a smaller patch"
    });
    expect(parseCommand("/close")).toEqual({ type: "close" });
    expect(parseCommand("/pending")).toEqual({ type: "pending" });
  });

  it("maps plain text to run", () => {
    expect(parseCommand("fix failing build")).toEqual({
      type: "run",
      instruction: "fix failing build"
    });
  });

  it("returns unknown for malformed inputs", () => {
    expect(parseCommand("/mode invalid").type).toBe("unknown");
    expect(parseCommand("/repo").type).toBe("unknown");
    expect(parseCommand("/repo add only-name").type).toBe("unknown");
    expect(parseCommand("/repo init").type).toBe("unknown");
    expect(parseCommand("/repo remove").type).toBe("unknown");
    expect(parseCommand("/run").type).toBe("unknown");
    expect(parseCommand("/steer").type).toBe("unknown");
    expect(parseCommand("/ask why").type).toBe("unknown");
    expect(parseCommand("/task fix").type).toBe("unknown");
  });
});
