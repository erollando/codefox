import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistRepos, validateConfig } from "../src/core/config.js";

function makeValidConfig() {
  return {
    telegram: {
      allowedUserIds: [1],
      pollingTimeoutSeconds: 30,
      pollIntervalMs: 1000
    },
    repos: [{ name: "payments-api", rootPath: "/tmp/payments-api" }],
    codex: {
      command: "codex",
      baseArgs: [],
      runArgTemplate: ["{instruction}"],
      repoArgTemplate: [],
      timeoutMs: 1000
    },
    policy: { defaultMode: "observe" as const },
    audit: { logFilePath: "./logs/audit.log" }
  };
}

describe("config validation", () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:valid";
  });

  afterEach(() => {
    if (typeof originalToken === "undefined") {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });

  it("requires TELEGRAM_BOT_TOKEN environment variable", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const config = makeValidConfig();
    expect(() => validateConfig(config)).toThrowError(/TELEGRAM_BOT_TOKEN/);
  });

  it("accepts valid minimal config", () => {
    const config = makeValidConfig();
    const validated = validateConfig(config);
    expect(validated.telegram.token).toBe("123456:valid");
    expect(validated.telegram.discardBacklogOnStart).toBe(true);
    expect(validated.safety.requireAgentsForRuns).toBe(false);
    expect(validated.state.filePath.endsWith(path.join(".codefox", "state.json"))).toBe(true);
    expect(validated.repoInit.defaultParentPath.endsWith(path.join("git"))).toBe(true);
    expect(validated.safety.instructionPolicy.forbiddenPathPatterns).toContain(".env");
    expect(validated.codex.blockedEnvVars).toContain("TELEGRAM_BOT_TOKEN");
    expect(validated.codex.preflightEnabled).toBe(true);
    expect(validated.codex.preflightArgs).toEqual(["--version"]);
    expect(validated.codex.preflightTimeoutMs).toBe(5000);
    expect(validated.state.codexSessionIdleMinutes).toBe(120);
    expect(validated.state.sessionTtlHours).toBeUndefined();
    expect(validated.state.approvalTtlHours).toBeUndefined();
  });

  it("accepts full-access as policy.defaultMode", () => {
    const config = makeValidConfig();
    (config.policy as { defaultMode: string }).defaultMode = "full-access";
    const validated = validateConfig(config);
    expect(validated.policy.defaultMode).toBe("full-access");
  });

  it("parses optional state TTL and codex session idle values", () => {
    const config = makeValidConfig();
    (config as Record<string, unknown>).state = {
      filePath: "./.codefox/state.json",
      sessionTtlHours: 72,
      approvalTtlHours: 24,
      codexSessionIdleMinutes: 45
    };
    const validated = validateConfig(config);
    expect(validated.state.sessionTtlHours).toBe(72);
    expect(validated.state.approvalTtlHours).toBe(24);
    expect(validated.state.codexSessionIdleMinutes).toBe(45);
  });

  it("parses optional repoInit.defaultParentPath", () => {
    const config = makeValidConfig();
    (config as Record<string, unknown>).repoInit = { defaultParentPath: "/tmp/codefox-repos" };
    const validated = validateConfig(config);
    expect(validated.repoInit.defaultParentPath).toBe(path.resolve("/tmp/codefox-repos"));
  });

  it("rejects duplicate allowed user IDs", () => {
    const config = makeValidConfig();
    config.telegram.allowedUserIds = [1, 1];
    expect(() => validateConfig(config)).toThrowError(/allowedUserIds/);
  });

  it("rejects non-positive polling values", () => {
    const config = makeValidConfig();
    config.telegram.pollIntervalMs = 0;
    expect(() => validateConfig(config)).toThrowError(/pollIntervalMs/);
  });

  it("parses optional telegram.discardBacklogOnStart override", () => {
    const config = makeValidConfig();
    (config.telegram as Record<string, unknown>).discardBacklogOnStart = false;
    const validated = validateConfig(config);
    expect(validated.telegram.discardBacklogOnStart).toBe(false);
  });

  it("rejects non-positive state TTL values", () => {
    const config = makeValidConfig();
    (config as Record<string, unknown>).state = {
      filePath: "./.codefox/state.json",
      sessionTtlHours: 0
    };
    expect(() => validateConfig(config)).toThrowError(/state\.sessionTtlHours/);
  });

  it("rejects non-positive codex session idle timeout", () => {
    const config = makeValidConfig();
    (config as Record<string, unknown>).state = {
      filePath: "./.codefox/state.json",
      codexSessionIdleMinutes: 0
    };
    expect(() => validateConfig(config)).toThrowError(/state\.codexSessionIdleMinutes/);
  });

  it("rejects overlapping repository roots", () => {
    const config = makeValidConfig();
    config.repos = [
      { name: "payments-api", rootPath: "/tmp/work/payments-api" },
      { name: "payments-api-child", rootPath: "/tmp/work/payments-api/service" }
    ];
    expect(() => validateConfig(config)).toThrowError(/must not overlap/);
  });

  it("accepts empty repository list when using runtime repo init/add", () => {
    const config = makeValidConfig();
    config.repos = [];
    const validated = validateConfig(config);
    expect(validated.repos).toEqual([]);
  });

  it("rejects empty codex run arg template", () => {
    const config = makeValidConfig();
    config.codex.runArgTemplate = [];
    expect(() => validateConfig(config)).toThrowError(/runArgTemplate/);
  });

  it("rejects run arg template without instruction placeholder", () => {
    const config = makeValidConfig();
    config.codex.runArgTemplate = ["--no-input"];
    expect(() => validateConfig(config)).toThrowError(/\{instruction\}/);
  });

  it("accepts missing codex.repoArgTemplate", () => {
    const config = makeValidConfig();
    delete (config.codex as Record<string, unknown>).repoArgTemplate;
    const validated = validateConfig(config);
    expect(validated.codex.repoArgTemplate).toEqual([]);
  });

  it("parses optional codex.blockedEnvVars override", () => {
    const config = makeValidConfig();
    (config.codex as Record<string, unknown>).blockedEnvVars = ["TELEGRAM_BOT_TOKEN", "CUSTOM_*"];
    const validated = validateConfig(config);
    expect(validated.codex.blockedEnvVars).toEqual(["TELEGRAM_BOT_TOKEN", "CUSTOM_*"]);
  });

  it("parses optional codex preflight overrides", () => {
    const config = makeValidConfig();
    (config.codex as Record<string, unknown>).preflightEnabled = false;
    (config.codex as Record<string, unknown>).preflightArgs = ["--help"];
    (config.codex as Record<string, unknown>).preflightTimeoutMs = 9000;
    const validated = validateConfig(config);
    expect(validated.codex.preflightEnabled).toBe(false);
    expect(validated.codex.preflightArgs).toEqual(["--help"]);
    expect(validated.codex.preflightTimeoutMs).toBe(9000);
  });

  it("rejects non-positive codex preflight timeout", () => {
    const config = makeValidConfig();
    (config.codex as Record<string, unknown>).preflightTimeoutMs = 0;
    expect(() => validateConfig(config)).toThrowError(/preflightTimeoutMs/);
  });

  it("persists repository list updates back to config json", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codefox-config-"));
    const configPath = path.join(dir, "codefox.config.json");
    await writeFile(configPath, JSON.stringify(makeValidConfig(), null, 2), "utf8");

    await persistRepos(configPath, [{ name: "new-repo", rootPath: "/tmp/new-repo" }]);
    const updated = JSON.parse(await readFile(configPath, "utf8")) as { repos: Array<{ name: string }> };

    expect(updated.repos).toEqual([{ name: "new-repo", rootPath: "/tmp/new-repo" }]);
  });
});
