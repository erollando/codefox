import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { CodexConfig, TaskContext, TaskResult } from "../types/domain.js";

export interface RunningTask {
  result: Promise<TaskResult>;
  abort: () => void;
}

export interface ProcessRunner {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ): ChildProcessWithoutNullStreams;
}

const defaultRunner: ProcessRunner = {
  spawn(command, args, options) {
    return spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe"
    });
  }
};

const RESUME_REJECTION_PATTERNS = [
  /unknown thread/i,
  /thread .* not found/i,
  /invalid thread/i,
  /cannot resume/i,
  /failed to resume/i,
  /resume rejected/i,
  /thread .* expired/i
] as const;

export class CodexCliAdapter {
  constructor(
    private readonly config: CodexConfig,
    private readonly runner: ProcessRunner = defaultRunner
  ) {}

  async ensureAvailable(): Promise<void> {
    if (!this.config.preflightEnabled) {
      return;
    }

    const env = buildChildEnv(process.env, this.config.blockedEnvVars);
    await new Promise<void>((resolve, reject) => {
      const child = this.runner.spawn(this.config.command, this.config.preflightArgs, {
        cwd: process.cwd(),
        env
      });
      let settled = false;
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        reject(
          new Error(
            `Codex preflight timed out after ${this.config.preflightTimeoutMs}ms for command '${this.config.command}'.`
          )
        );
      }, this.config.preflightTimeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to start Codex command '${this.config.command}': ${String(error)}`));
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
          return;
        }

        const outputPreview = [stdout, stderr].join("\n").trim().slice(0, 200);
        console.warn(
          `Codex preflight warning: '${this.config.command} ${this.config.preflightArgs.join(" ")}' exited with code ${code}.` +
            (outputPreview ? ` Output: ${outputPreview}` : "")
        );
        resolve();
      });
    });
  }

  startTask(repoPath: string, context: TaskContext, onProgress?: (line: string) => void | Promise<void>): RunningTask {
    const args = this.buildArgs(repoPath, context);
    const childEnv = buildChildEnv(process.env, this.config.blockedEnvVars);
    const child = this.runner.spawn(this.config.command, args, {
      cwd: repoPath,
      env: childEnv
    });

    let stdout = "";
    let stderr = "";
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let detectedThreadId: string | undefined;
    let resumeRejected = false;

    const resolveOnce = (resolve: (result: TaskResult) => void, result: TaskResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, this.config.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutRemainder = emitLines(text, stdoutRemainder, onProgress);
      detectedThreadId = detectThreadId(text) ?? detectedThreadId;
      if (context.resumeThreadId && isResumeRejected(text)) {
        resumeRejected = true;
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrRemainder = emitLines(text, stderrRemainder, onProgress);
      detectedThreadId = detectThreadId(text) ?? detectedThreadId;
      if (context.resumeThreadId && isResumeRejected(text)) {
        resumeRejected = true;
      }
    });

    const result = new Promise<TaskResult>((resolve) => {
      child.on("error", (error) => {
        clearTimeout(timeout);
        resolveOnce(resolve, {
          ok: false,
          summary: `Codex spawn failed: ${String(error)}`,
          outputTail: [stdout, stderr].join("\n").trim(),
          threadId: detectedThreadId ?? context.resumeThreadId,
          resumeRejected
        });
      });

      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        flushRemainder(stdoutRemainder, onProgress);
        flushRemainder(stderrRemainder, onProgress);
        const combined = [stdout, stderr].join("\n").trim();
        const combinedResumeRejected = context.resumeThreadId ? resumeRejected || isResumeRejected(combined) : false;
        const isOk = exitCode === 0 && !timedOut && !aborted;
        resolveOnce(resolve, {
          ok: isOk,
          summary: summarizeOutput(exitCode ?? -1, combined, timedOut, aborted, this.config.timeoutMs),
          outputTail: combined,
          exitCode: exitCode ?? -1,
          timedOut,
          aborted,
          threadId: detectedThreadId ?? context.resumeThreadId,
          resumeRejected: combinedResumeRejected
        });
      });
    });

    return {
      result,
      abort: () => {
        aborted = true;
        child.kill();
      }
    };
  }

  private buildArgs(repoPath: string, context: TaskContext): string[] {
    const instruction = buildInstruction(context);
    const globalArgs = buildGlobalArgs(this.config, context);
    const sandboxArgs = buildSandboxArgs(this.config.command, this.config.baseArgs, context.mode);
    const repoArgs = this.config.repoArgTemplate.map((value) => value.replaceAll("{repoPath}", repoPath));

    const templateHasThreadPlaceholder = this.config.runArgTemplate.some((value) => value.includes("{threadId}"));
    const resumeArgs =
      context.resumeThreadId && shouldInjectCodexResume(this.config.command, this.config.baseArgs) && !templateHasThreadPlaceholder
        ? ["resume", context.resumeThreadId]
        : [];

    const runArgs = this.config.runArgTemplate
      .map((value) => {
        const replacedInstruction = value.replaceAll("{instruction}", instruction);
        if (!context.resumeThreadId && replacedInstruction === "{threadId}") {
          return "";
        }
        return replacedInstruction.replaceAll("{threadId}", context.resumeThreadId ?? "");
      })
      .filter((value) => value.length > 0);

    return [...globalArgs, ...this.config.baseArgs, ...sandboxArgs, ...repoArgs, ...resumeArgs, ...runArgs];
  }
}

function buildGlobalArgs(config: CodexConfig, context: TaskContext): string[] {
  const args: string[] = [];

  if (config.profile) {
    args.push("--profile", config.profile);
  }
  if (config.model) {
    args.push("--model", config.model);
  }
  const effectiveReasoningEffort = context.reasoningEffortOverride ?? config.reasoningEffort;
  if (effectiveReasoningEffort) {
    args.push("-c", `model_reasoning_effort="${effectiveReasoningEffort}"`);
  }
  for (const attachment of context.attachments ?? []) {
    if (attachment.kind === "image") {
      args.push("--image", attachment.localPath);
    }
  }
  for (const override of config.configOverrides ?? []) {
    args.push("-c", override);
  }

  return args;
}

function shouldInjectCodexResume(command: string, baseArgs: string[]): boolean {
  if (!isCodexCommand(command)) {
    return false;
  }
  return baseArgs.includes("exec");
}

function buildSandboxArgs(command: string, baseArgs: string[], mode: TaskContext["mode"]): string[] {
  if (!isCodexCommand(command)) {
    return [];
  }
  if (hasSandboxArgs(baseArgs)) {
    return [];
  }
  switch (mode) {
    case "observe":
      return ["--sandbox", "read-only"];
    case "active":
      return ["--sandbox", "workspace-write"];
    case "full-access":
      return ["--sandbox", "danger-full-access"];
  }
}

function isCodexCommand(command: string): boolean {
  const name = path.basename(command).toLowerCase();
  return name === "codex" || name === "codex.exe";
}

function hasSandboxArgs(args: string[]): boolean {
  return (
    args.includes("--sandbox") ||
    args.includes("-s") ||
    args.includes("--full-auto") ||
    args.includes("--dangerously-bypass-approvals-and-sandbox")
  );
}

function buildChildEnv(source: NodeJS.ProcessEnv, blockedPatterns: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "undefined") {
      continue;
    }
    if (isBlockedEnvVar(key, blockedPatterns)) {
      continue;
    }
    env[key] = value;
  }

  return env;
}

function isBlockedEnvVar(name: string, patterns: string[]): boolean {
  const normalizedName = name.toUpperCase();
  for (const pattern of patterns) {
    const normalizedPattern = pattern.trim().toUpperCase();
    if (!normalizedPattern) {
      continue;
    }
    if (normalizedPattern.endsWith("*")) {
      const prefix = normalizedPattern.slice(0, -1);
      if (normalizedName.startsWith(prefix)) {
        return true;
      }
      continue;
    }
    if (normalizedName === normalizedPattern) {
      return true;
    }
  }
  return false;
}

function emitLines(text: string, previousRemainder: string, onProgress?: (line: string) => void | Promise<void>): string {
  if (!onProgress) {
    return "";
  }

  const combined = `${previousRemainder}${text}`;
  const lines = combined.split(/\r?\n/);
  const remainder = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim().slice(0, 500);
    if (trimmed) {
      const maybePromise = onProgress(trimmed);
      if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
        void (maybePromise as Promise<void>).catch(() => {});
      }
    }
  }

  return remainder;
}

function flushRemainder(remainder: string, onProgress?: (line: string) => void | Promise<void>): void {
  if (!onProgress) {
    return;
  }
  const trimmed = remainder.trim().slice(0, 500);
  if (!trimmed) {
    return;
  }
  const maybePromise = onProgress(trimmed);
  if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
    void (maybePromise as Promise<void>).catch(() => {});
  }
}

function summarizeOutput(exitCode: number, output: string, timedOut: boolean, aborted: boolean, timeoutMs: number): string {
  if (aborted) {
    return "Run aborted by user.";
  }

  if (timedOut) {
    return `Codex run timed out after ${timeoutMs}ms.`;
  }

  if (exitCode === 0) {
    return extractAssistantSummary(output) ?? "Completed successfully.";
  }

  if (!output) {
    return `Codex exited with code ${exitCode}`;
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1].slice(0, 400);
}

function buildInstruction(context: TaskContext): string {
  const guidanceBlock =
    context.systemGuidance && context.systemGuidance.length > 0
      ? ["System safety guidance:", ...context.systemGuidance]
      : [];

  return [
    "You are Codex running through CodeFox.",
    `repo: ${context.repoName}`,
    `mode: ${context.mode}`,
    `request_id: ${context.requestId}`,
    `run_kind: ${context.runKind}`,
    ...(context.resumeThreadId ? [`resume_thread_id: ${context.resumeThreadId}`] : []),
    ...guidanceBlock,
    ...buildAttachmentGuidance(context),
    "User instruction:",
    context.instruction
  ].join("\n");
}

function buildAttachmentGuidance(context: TaskContext): string[] {
  const attachments = context.attachments ?? [];
  if (attachments.length === 0) {
    return [];
  }

  const lines = ["Attachments:"];
  for (const attachment of attachments) {
    lines.push(
      `- ${attachment.kind}: ${attachment.originalName ?? "unnamed"} (${attachment.mimeType ?? "unknown"}) at ${
        attachment.localPath
      }`
    );
  }
  lines.push("Use these attachments as additional context for the user request.");
  return lines;
}

function detectThreadId(text: string): string | undefined {
  const jsonThread = matchLast(text, /"thread(?:_|-)id"\s*:\s*"([^"]+)"/gi);
  if (jsonThread) {
    return jsonThread;
  }

  const camelThread = matchLast(text, /"threadId"\s*:\s*"([^"]+)"/gi);
  if (camelThread) {
    return camelThread;
  }

  const labeled = matchLast(text, /thread(?:_|-|\s)+id\s*[:=]\s*([A-Za-z0-9._:-]+)/gi);
  if (labeled) {
    return labeled;
  }

  const threadToken = matchLast(text, /\b(thread_[A-Za-z0-9._:-]+)\b/g);
  if (threadToken) {
    return threadToken;
  }

  // Plain-text Codex exec output commonly prints "session id: <uuid>".
  const sessionId = matchLast(
    text,
    /session id\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi
  );
  return sessionId;
}

function matchLast(text: string, pattern: RegExp): string | undefined {
  let found: string | undefined;
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) {
      found = value;
    }
  }
  return found;
}

function isResumeRejected(text: string): boolean {
  return RESUME_REJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function extractAssistantSummary(output: string): string | undefined {
  const normalized = output.replace(/\r\n/g, "\n");

  const jsonSummary = extractJsonAgentMessage(normalized);
  if (jsonSummary) {
    return jsonSummary.slice(0, 400);
  }

  const codexSummary = extractPlainCodexMessage(normalized);
  if (codexSummary) {
    return codexSummary.slice(0, 400);
  }

  return undefined;
}

function extractJsonAgentMessage(text: string): string | undefined {
  let last: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item.text) {
        last = parsed.item.text.trim();
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return last;
}

function extractPlainCodexMessage(text: string): string | undefined {
  const lines = text.split("\n");
  let last: string | undefined;

  let inCodexBlock = false;
  let currentBlock: string[] = [];

  const flushCurrent = (): void => {
    if (currentBlock.length === 0) {
      return;
    }
    const candidate = currentBlock.join("\n").trim();
    if (candidate) {
      last = candidate;
    }
    currentBlock = [];
  };

  for (const line of lines) {
    const normalized = line.trim().toLowerCase();
    if (normalized === "codex") {
      flushCurrent();
      inCodexBlock = true;
      continue;
    }

    if (!inCodexBlock) {
      continue;
    }

    if (normalized === "user" || normalized === "exec" || normalized === "tokens used") {
      flushCurrent();
      inCodexBlock = false;
      continue;
    }

    currentBlock.push(line);
  }

  flushCurrent();
  return last;
}
