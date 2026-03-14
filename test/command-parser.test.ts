import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/core/command-parser.js";

describe("parseCommand", () => {
  it("parses slash commands", () => {
    expect(parseCommand("/help")).toEqual({ type: "help" });
    expect(parseCommand("/help@codefox_bot")).toEqual({ type: "help" });
    expect(parseCommand("/spec template")).toEqual({
      type: "spec",
      action: "template"
    });
    expect(parseCommand("/spec draft add invoice csv export")).toEqual({
      type: "spec",
      action: "draft",
      intent: "add invoice csv export"
    });
    expect(parseCommand("/spec show")).toEqual({
      type: "spec",
      action: "show"
    });
    expect(parseCommand("/spec status")).toEqual({
      type: "spec",
      action: "status"
    });
    expect(parseCommand("/spec approve")).toEqual({
      type: "spec",
      action: "approve",
      force: false
    });
    expect(parseCommand("/spec approve force")).toEqual({
      type: "spec",
      action: "approve",
      force: true
    });
    expect(parseCommand("/spec clear")).toEqual({
      type: "spec",
      action: "clear"
    });
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
    expect(parseCommand("/repo bootstrap pii-api python")).toEqual({
      type: "repo_bootstrap",
      repoName: "pii-api",
      template: "python",
      basePath: undefined
    });
    expect(parseCommand("/repo bootstrap pii-api nodejs /tmp/work")).toEqual({
      type: "repo_bootstrap",
      repoName: "pii-api",
      template: "nodejs",
      basePath: "/tmp/work"
    });
    expect(parseCommand("/repo template pii-api java")).toEqual({
      type: "repo_template",
      repoName: "pii-api",
      template: "java"
    });
    expect(parseCommand("/repo playbook pii-api")).toEqual({
      type: "repo_playbook",
      repoName: "pii-api",
      overwrite: false
    });
    expect(parseCommand("/repo playbook pii-api overwrite")).toEqual({
      type: "repo_playbook",
      repoName: "pii-api",
      overwrite: true
    });
    expect(parseCommand("/repo guide")).toEqual({
      type: "repo_guide",
      repoName: undefined
    });
    expect(parseCommand("/repo guide pii-api")).toEqual({
      type: "repo_guide",
      repoName: "pii-api"
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
    expect(parseCommand("/reasoning high")).toEqual({
      type: "reasoning",
      reasoningEffort: "high"
    });
    expect(parseCommand("/effort low")).toEqual({
      type: "reasoning",
      reasoningEffort: "low"
    });
    expect(parseCommand("/reasoning default")).toEqual({
      type: "reasoning",
      reasoningEffort: undefined
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
    expect(parseCommand("/spec").type).toBe("unknown");
    expect(parseCommand("/spec draft").type).toBe("unknown");
    expect(parseCommand("/spec approve now").type).toBe("unknown");
    expect(parseCommand("/spec clear now").type).toBe("unknown");
    expect(parseCommand("/repo").type).toBe("unknown");
    expect(parseCommand("/repo add only-name").type).toBe("unknown");
    expect(parseCommand("/repo init").type).toBe("unknown");
    expect(parseCommand("/repo bootstrap").type).toBe("unknown");
    expect(parseCommand("/repo bootstrap pii-api ruby").type).toBe("unknown");
    expect(parseCommand("/repo template pii-api").type).toBe("unknown");
    expect(parseCommand("/repo template pii-api ruby").type).toBe("unknown");
    expect(parseCommand("/repo playbook").type).toBe("unknown");
    expect(parseCommand("/repo playbook pii-api force").type).toBe("unknown");
    expect(parseCommand("/repo guide pii-api extra").type).toBe("unknown");
    expect(parseCommand("/repo remove").type).toBe("unknown");
    expect(parseCommand("/run").type).toBe("unknown");
    expect(parseCommand("/steer").type).toBe("unknown");
    expect(parseCommand("/codex-changelog").type).toBe("unknown");
    expect(parseCommand("/changelog").type).toBe("unknown");
    expect(parseCommand("/reasoning insane").type).toBe("unknown");
    expect(parseCommand("/ask why").type).toBe("unknown");
    expect(parseCommand("/task fix").type).toBe("unknown");
  });
});
