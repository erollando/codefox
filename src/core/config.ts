import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";
import type {
  AppConfig,
  CodexReasoningEffort,
  PolicyMode,
  RepoConfig,
  SpecPolicyConfigOverride,
  SpecPolicyModeConfigOverride,
  SpecSectionName
} from "../types/domain.js";

const MODES: PolicyMode[] = ["observe", "active", "full-access"];
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
const DEFAULT_CODEX_BLOCKED_ENV_VARS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_TOKEN", "CODEFOX_*"] as const;
const DEFAULT_CODEX_SESSION_IDLE_MINUTES = 120;
const DEFAULT_AUDIT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CODEX_REASONING_EFFORTS: CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const SPEC_POLICY_MODE_OPTION_KEYS = new Set([
  "requireApprovedSpecForRun",
  "allowForceApproval",
  "requiredSectionsForApproval"
]);
const SPEC_SECTION_NAMES: SpecSectionName[] = [
  "REQUEST",
  "GOAL",
  "OUTCOME",
  "CONSTRAINTS",
  "NON_GOALS",
  "CONTEXT",
  "ASSUMPTIONS",
  "QUESTIONS",
  "PLAN",
  "APPROVALS_REQUIRED",
  "DONE_WHEN"
];

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

function assertNoOverlappingRepoRoots(repos: Array<{ name: string; rootPath: string }>): void {
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

function parseOptionalCodexReasoningEffort(value: unknown, key: string): CodexReasoningEffort | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  const effort = mustString(value, key) as CodexReasoningEffort;
  if (!CODEX_REASONING_EFFORTS.includes(effort)) {
    throw new ConfigError(`${key} must be one of ${CODEX_REASONING_EFFORTS.join(", ")}`);
  }
  return effort;
}

function parseOptionalSpecPolicyOverride(value: unknown, key: string): SpecPolicyConfigOverride | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${key} must be an object`);
  }

  const raw = value as Record<string, unknown>;
  for (const modeKey of Object.keys(raw)) {
    if (!MODES.includes(modeKey as PolicyMode)) {
      throw new ConfigError(`${key}.${modeKey} is not a supported mode`);
    }
  }

  const result: SpecPolicyConfigOverride = {};
  for (const mode of MODES) {
    if (!(mode in raw)) {
      continue;
    }
    const modeValue = raw[mode];
    if (!modeValue || typeof modeValue !== "object" || Array.isArray(modeValue)) {
      throw new ConfigError(`${key}.${mode} must be an object`);
    }
    const modeObj = modeValue as Record<string, unknown>;
    const modeOverride: SpecPolicyModeConfigOverride = {};

    for (const optionKey of Object.keys(modeObj)) {
      if (!SPEC_POLICY_MODE_OPTION_KEYS.has(optionKey)) {
        throw new ConfigError(`${key}.${mode}.${optionKey} is not a supported option`);
      }
    }

    if (typeof modeObj.requireApprovedSpecForRun !== "undefined") {
      if (typeof modeObj.requireApprovedSpecForRun !== "boolean") {
        throw new ConfigError(`${key}.${mode}.requireApprovedSpecForRun must be a boolean`);
      }
      modeOverride.requireApprovedSpecForRun = modeObj.requireApprovedSpecForRun;
    }

    if (typeof modeObj.allowForceApproval !== "undefined") {
      if (typeof modeObj.allowForceApproval !== "boolean") {
        throw new ConfigError(`${key}.${mode}.allowForceApproval must be a boolean`);
      }
      modeOverride.allowForceApproval = modeObj.allowForceApproval;
    }

    if (typeof modeObj.requiredSectionsForApproval !== "undefined") {
      const sections = mustStringArray(modeObj.requiredSectionsForApproval, `${key}.${mode}.requiredSectionsForApproval`);
      for (let index = 0; index < sections.length; index += 1) {
        if (!SPEC_SECTION_NAMES.includes(sections[index] as SpecSectionName)) {
          throw new ConfigError(`${key}.${mode}.requiredSectionsForApproval[${index}] is not a supported section`);
        }
      }
      modeOverride.requiredSectionsForApproval = sections as SpecSectionName[];
    }

    result[mode] = modeOverride;
  }

  return result;
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

  const pollingTimeoutSeconds = mustNumber(telegram.pollingTimeoutSeconds, "telegram.pollingTimeoutSeconds");
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
  const configOverrides = codex.configOverrides
    ? mustStringArray(codex.configOverrides, "codex.configOverrides")
    : [];
  const runArgTemplate = mustArray<string>(codex.runArgTemplate, "codex.runArgTemplate");
  const repoArgTemplate = codex.repoArgTemplate ? mustArray<string>(codex.repoArgTemplate, "codex.repoArgTemplate") : [];
  const preflightArgs = codex.preflightArgs ? mustArray<string>(codex.preflightArgs, "codex.preflightArgs") : ["--version"];
  assertNonEmptyArray(runArgTemplate, "codex.runArgTemplate");
  assertNonEmptyArray(preflightArgs, "codex.preflightArgs");

  if (!runArgTemplate.some((value) => value.includes("{instruction}"))) {
    throw new ConfigError("codex.runArgTemplate must include at least one '{instruction}' placeholder");
  }

  const codexSessionIdleMinutes =
    typeof state.codexSessionIdleMinutes === "undefined"
      ? DEFAULT_CODEX_SESSION_IDLE_MINUTES
      : mustNumber(state.codexSessionIdleMinutes, "state.codexSessionIdleMinutes");
  assertPositiveInteger(codexSessionIdleMinutes, "state.codexSessionIdleMinutes");

  return {
    telegram: {
      token,
      allowedUserIds,
      allowedChatIds,
      pollingTimeoutSeconds,
      pollIntervalMs,
      discardBacklogOnStart:
        typeof telegram.discardBacklogOnStart === "boolean" ? telegram.discardBacklogOnStart : true
    },
    repos: normalizedRepos,
    codex: {
      command: mustString(codex.command, "codex.command"),
      baseArgs,
      model: codex.model ? mustString(codex.model, "codex.model") : undefined,
      profile: codex.profile ? mustString(codex.profile, "codex.profile") : undefined,
      reasoningEffort: parseOptionalCodexReasoningEffort(codex.reasoningEffort, "codex.reasoningEffort"),
      configOverrides,
      runArgTemplate,
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
      defaultMode: mustMode(policy.defaultMode, "policy.defaultMode"),
      specPolicy: parseOptionalSpecPolicyOverride(policy.specPolicy, "policy.specPolicy")
    },
    safety: {
      requireAgentsForRuns: Boolean(safety.requireAgentsForRuns),
      instructionPolicy: {
        blockedPatterns: instructionPolicy.blockedPatterns
          ? mustStringArray(instructionPolicy.blockedPatterns, "safety.instructionPolicy.blockedPatterns")
          : [],
        allowedDownloadDomains: instructionPolicy.allowedDownloadDomains
          ? mustStringArray(instructionPolicy.allowedDownloadDomains, "safety.instructionPolicy.allowedDownloadDomains")
          : [],
        forbiddenPathPatterns: instructionPolicy.forbiddenPathPatterns
          ? mustStringArray(instructionPolicy.forbiddenPathPatterns, "safety.instructionPolicy.forbiddenPathPatterns")
          : [...DEFAULT_FORBIDDEN_PATH_PATTERNS]
      }
    },
    repoInit: {
      defaultParentPath: resolveFromBase(
        baseDir,
        repoInit.defaultParentPath ? mustString(repoInit.defaultParentPath, "repoInit.defaultParentPath") : "./git"
      )
    },
    state: {
      filePath: resolveFromBase(
        baseDir,
        state.filePath ? mustString(state.filePath, "state.filePath") : "./.codefox/state.json"
      ),
      sessionTtlHours: parseOptionalPositiveNumber(state.sessionTtlHours, "state.sessionTtlHours"),
      approvalTtlHours: parseOptionalPositiveNumber(state.approvalTtlHours, "state.approvalTtlHours"),
      codexSessionIdleMinutes
    },
    audit: {
      logFilePath: resolveFromBase(baseDir, mustString(audit.logFilePath, "audit.logFilePath")),
      maxFileBytes: parseOptionalPositiveInteger(audit.maxFileBytes, "audit.maxFileBytes") ?? DEFAULT_AUDIT_MAX_FILE_BYTES
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

function parseOptionalPositiveInteger(value: unknown, key: string): number | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }
  const num = mustNumber(value, key);
  assertPositiveInteger(num, key);
  return num;
}

function resolveFromBase(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDir, value);
}
