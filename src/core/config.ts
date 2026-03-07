import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";
import type { AppConfig, PlainTextMode, PolicyMode, RepoConfig } from "../types/domain.js";

const MODES: PolicyMode[] = ["observe", "active", "full-access"];
const PLAIN_TEXT_MODES: PlainTextMode[] = ["task", "ask"];
const DEFAULT_FORBIDDEN_PATH_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  ".aws/**",
  ".ssh/**",
  "credentials/**",
  "secrets/**"
] as const;
const DEFAULT_CODEX_BLOCKED_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_TOKEN",
  "CODEFOX_*"
] as const;

function isMode(value: string): value is PolicyMode {
  return MODES.includes(value as PolicyMode);
}

function mustArray<T>(value: unknown, key: string): T[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${key} must be an array`);
  }
  return value as T[];
}

function mustStringArray(value: unknown, key: string): string[] {
  const arr = mustArray<unknown>(value, key);
  const normalized: string[] = [];
  for (let i = 0; i < arr.length; i += 1) {
    normalized.push(mustString(arr[i], `${key}[${i}]`));
  }
  return normalized;
}

function mustString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${key} must be a non-empty string`);
  }
  return value;
}

function mustNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(`${key} must be a number`);
  }
  return value;
}

function assertPositiveInteger(value: number, key: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive integer`);
  }
}

function assertPositiveNumber(value: number, key: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${key} must be a positive number`);
  }
}

function assertNonEmptyArray<T>(items: T[], key: string): void {
  if (items.length === 0) {
    throw new ConfigError(`${key} must not be empty`);
  }
}

function assertUniqueNumbers(values: number[], key: string): void {
  if (new Set(values).size !== values.length) {
    throw new ConfigError(`${key} must not contain duplicates`);
  }
}

function assertPositiveSafeInteger(value: number, key: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(`${key} must contain positive integer IDs`);
  }
}

function validateIdList(values: number[], key: string, allowEmpty: boolean): number[] {
  if (!allowEmpty) {
    assertNonEmptyArray(values, key);
  }

  for (let index = 0; index < values.length; index += 1) {
    assertPositiveSafeInteger(values[index], `${key}[${index}]`);
  }
  assertUniqueNumbers(values, key);
  return values;
}

function normalizePathForCompare(inputPath: string): string {
  return process.platform === "win32" ? inputPath.toLowerCase() : inputPath;
}

function isWithinPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertNoOverlappingRepoRoots(
  repos: Array<{ name: string; rootPath: string }>
): void {
  for (let i = 0; i < repos.length; i += 1) {
    for (let j = i + 1; j < repos.length; j += 1) {
      const left = repos[i];
      const right = repos[j];
      const leftPath = normalizePathForCompare(left.rootPath);
      const rightPath = normalizePathForCompare(right.rootPath);

      if (isWithinPath(leftPath, rightPath) || isWithinPath(rightPath, leftPath)) {
        throw new ConfigError(
          `Repository roots must not overlap: '${left.name}' (${left.rootPath}) and '${right.name}' (${right.rootPath})`
        );
      }
    }
  }
}

function mustMode(value: unknown, key: string): PolicyMode {
  const mode = mustString(value, key);
  if (!isMode(mode)) {
    throw new ConfigError(`${key} must be one of ${MODES.join(", ")}`);
  }
  return mode;
}

function mustPlainTextMode(value: unknown, key: string): PlainTextMode {
  const mode = mustString(value, key);
  if (!PLAIN_TEXT_MODES.includes(mode as PlainTextMode)) {
    throw new ConfigError(`${key} must be one of ${PLAIN_TEXT_MODES.join(", ")}`);
  }
  return mode as PlainTextMode;
}

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolvedPath = resolveConfigPath(configPath);

  const raw = await readFile(resolvedPath, "utf8").catch((err) => {
    throw new ConfigError(`Failed to read config at ${resolvedPath}: ${String(err)}`);
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config is not valid JSON: ${String(err)}`);
  }

  return validateConfig(parsed, path.dirname(resolvedPath));
}

export function resolveConfigPath(configPath?: string): string {
  return configPath
    ? path.resolve(configPath)
    : path.resolve(process.env.CODEFOX_CONFIG ?? "./config/codefox.config.json");
}

export async function persistRepos(configPath: string, repos: RepoConfig[]): Promise<void> {
  const resolvedPath = resolveConfigPath(configPath);
  const raw = await readFile(resolvedPath, "utf8").catch((err) => {
    throw new ConfigError(`Failed to read config at ${resolvedPath}: ${String(err)}`);
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config is not valid JSON: ${String(err)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ConfigError("Config must be an object");
  }

  const draft = parsed as Record<string, unknown>;
  draft.repos = repos.map((repo) => ({
    name: repo.name,
    rootPath: path.resolve(repo.rootPath)
  }));

  await writeFile(resolvedPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
}

export function validateConfig(parsed: unknown, baseDir: string = process.cwd()): AppConfig {
  if (!parsed || typeof parsed !== "object") {
    throw new ConfigError("Config must be an object");
  }

  const config = parsed as Record<string, unknown>;
  const telegram = config.telegram as Record<string, unknown>;
  const repos = mustArray<Record<string, unknown>>(config.repos, "repos");
  const codex = config.codex as Record<string, unknown>;
  const policy = config.policy as Record<string, unknown>;
  const repoInit = (config.repoInit as Record<string, unknown> | undefined) ?? {};
  const safety = (config.safety as Record<string, unknown> | undefined) ?? {};
  const instructionPolicy = (safety.instructionPolicy as Record<string, unknown> | undefined) ?? {};
  const state = (config.state as Record<string, unknown> | undefined) ?? {};
  const audit = config.audit as Record<string, unknown>;

  if (!telegram || !codex || !policy || !audit) {
    throw new ConfigError("Config must include telegram, codex, policy, and audit sections");
  }

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new ConfigError("TELEGRAM_BOT_TOKEN environment variable must be set");
  }

  const allowedUserIds = validateIdList(
    mustArray<number>(telegram.allowedUserIds, "telegram.allowedUserIds"),
    "telegram.allowedUserIds",
    false
  );

  const allowedChatIds = telegram.allowedChatIds
    ? validateIdList(
        mustArray<number>(telegram.allowedChatIds, "telegram.allowedChatIds"),
        "telegram.allowedChatIds",
        true
      )
    : undefined;

  const pollingTimeoutSeconds = mustNumber(
    telegram.pollingTimeoutSeconds,
    "telegram.pollingTimeoutSeconds"
  );
  const pollIntervalMs = mustNumber(telegram.pollIntervalMs, "telegram.pollIntervalMs");
  assertPositiveInteger(pollingTimeoutSeconds, "telegram.pollingTimeoutSeconds");
  assertPositiveInteger(pollIntervalMs, "telegram.pollIntervalMs");

  const normalizedRepos = repos.map((repo, index) => ({
    name: mustString(repo.name, `repos[${index}].name`),
    rootPath: path.resolve(mustString(repo.rootPath, `repos[${index}].rootPath`))
  }));
  assertNoOverlappingRepoRoots(normalizedRepos);

  const uniqueNames = new Set(normalizedRepos.map((repo) => repo.name));
  if (uniqueNames.size !== normalizedRepos.length) {
    throw new ConfigError("Repository names must be unique");
  }

  const timeoutMs = mustNumber(codex.timeoutMs, "codex.timeoutMs");
  assertPositiveInteger(timeoutMs, "codex.timeoutMs");
  const preflightTimeoutMs =
    typeof codex.preflightTimeoutMs === "undefined"
      ? 5000
      : mustNumber(codex.preflightTimeoutMs, "codex.preflightTimeoutMs");
  assertPositiveInteger(preflightTimeoutMs, "codex.preflightTimeoutMs");
  const baseArgs = mustArray<string>(codex.baseArgs, "codex.baseArgs");
  const askArgTemplate = mustArray<string>(codex.askArgTemplate, "codex.askArgTemplate");
  const taskArgTemplate = mustArray<string>(codex.taskArgTemplate, "codex.taskArgTemplate");
  const repoArgTemplate = codex.repoArgTemplate
    ? mustArray<string>(codex.repoArgTemplate, "codex.repoArgTemplate")
    : [];
  const preflightArgs = codex.preflightArgs
    ? mustArray<string>(codex.preflightArgs, "codex.preflightArgs")
    : ["--version"];
  assertNonEmptyArray(askArgTemplate, "codex.askArgTemplate");
  assertNonEmptyArray(taskArgTemplate, "codex.taskArgTemplate");
  assertNonEmptyArray(preflightArgs, "codex.preflightArgs");

  return {
    telegram: {
      token,
      allowedUserIds,
      allowedChatIds,
      pollingTimeoutSeconds,
      pollIntervalMs,
      discardBacklogOnStart:
        typeof telegram.discardBacklogOnStart === "boolean" ? telegram.discardBacklogOnStart : true,
      plainTextMode: mustPlainTextMode(telegram.plainTextMode, "telegram.plainTextMode")
    },
    repos: normalizedRepos,
    codex: {
      command: mustString(codex.command, "codex.command"),
      baseArgs,
      askArgTemplate,
      taskArgTemplate,
      repoArgTemplate,
      timeoutMs,
      blockedEnvVars: codex.blockedEnvVars
        ? mustStringArray(codex.blockedEnvVars, "codex.blockedEnvVars")
        : [...DEFAULT_CODEX_BLOCKED_ENV_VARS],
      preflightEnabled: typeof codex.preflightEnabled === "boolean" ? codex.preflightEnabled : true,
      preflightArgs,
      preflightTimeoutMs
    },
    policy: {
      defaultMode: mustMode(policy.defaultMode, "policy.defaultMode")
    },
    safety: {
      requireAgentsForMutatingTasks: Boolean(safety.requireAgentsForMutatingTasks),
      instructionPolicy: {
        enforceOnAsk: Boolean(instructionPolicy.enforceOnAsk),
        blockedPatterns: instructionPolicy.blockedPatterns
          ? mustStringArray(instructionPolicy.blockedPatterns, "safety.instructionPolicy.blockedPatterns")
          : [],
        allowedDownloadDomains: instructionPolicy.allowedDownloadDomains
          ? mustStringArray(
              instructionPolicy.allowedDownloadDomains,
              "safety.instructionPolicy.allowedDownloadDomains"
            )
          : [],
        forbiddenPathPatterns: instructionPolicy.forbiddenPathPatterns
          ? mustStringArray(
              instructionPolicy.forbiddenPathPatterns,
              "safety.instructionPolicy.forbiddenPathPatterns"
            )
          : [...DEFAULT_FORBIDDEN_PATH_PATTERNS]
      }
    },
    repoInit: {
      defaultParentPath: resolveFromBase(
        baseDir,
        repoInit.defaultParentPath
          ? mustString(repoInit.defaultParentPath, "repoInit.defaultParentPath")
          : "./git"
      )
    },
    state: {
      filePath: resolveFromBase(
        baseDir,
        state.filePath ? mustString(state.filePath, "state.filePath") : "./.codefox/state.json"
      ),
      sessionTtlHours: parseOptionalPositiveNumber(state.sessionTtlHours, "state.sessionTtlHours"),
      approvalTtlHours: parseOptionalPositiveNumber(state.approvalTtlHours, "state.approvalTtlHours")
    },
    audit: {
      logFilePath: resolveFromBase(baseDir, mustString(audit.logFilePath, "audit.logFilePath"))
    }
  };
}


function parseOptionalPositiveNumber(value: unknown, key: string): number | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  const num = mustNumber(value, key);
  assertPositiveNumber(num, key);
  return num;
}

function resolveFromBase(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value);
}
