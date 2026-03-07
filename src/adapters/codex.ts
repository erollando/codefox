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

  startTask(
    repoPath: string,
    context: TaskContext,
    onProgress?: (line: string) => void | Promise<void>
  ): RunningTask {
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
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrRemainder = emitLines(text, stderrRemainder, onProgress);
    });

    const result = new Promise<TaskResult>((resolve) => {
      child.on("error", (error) => {
        clearTimeout(timeout);
        resolveOnce(resolve, {
          ok: false,
          summary: `Codex spawn failed: ${String(error)}`,
          outputTail: [stdout, stderr].join("\n").trim()
        });
      });

      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        flushRemainder(stdoutRemainder, onProgress);
        flushRemainder(stderrRemainder, onProgress);
        const combined = [stdout, stderr].join("\n").trim();
        const isOk = exitCode === 0 && !timedOut && !aborted;
        resolveOnce(resolve, {
          ok: isOk,
          summary: summarizeOutput(exitCode ?? -1, combined, timedOut, aborted, this.config.timeoutMs),
          outputTail: combined,
          exitCode: exitCode ?? -1,
          timedOut,
          aborted
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
    const sandboxArgs = buildSandboxArgs(this.config.command, this.config.baseArgs, context.mode);
    const repoArgs = this.config.repoArgTemplate.map((value) =>
      value.replaceAll("{repoPath}", repoPath)
    );

    const template = context.taskType === "ask" ? this.config.askArgTemplate : this.config.taskArgTemplate;
    const taskArgs = template.map((value) => value.replaceAll("{instruction}", instruction));

    return [...this.config.baseArgs, ...sandboxArgs, ...repoArgs, ...taskArgs];
  }
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

function buildChildEnv(
  source: NodeJS.ProcessEnv,
  blockedPatterns: string[]
): NodeJS.ProcessEnv {
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

function emitLines(
  text: string,
  previousRemainder: string,
  onProgress?: (line: string) => void | Promise<void>
): string {
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

function flushRemainder(
  remainder: string,
  onProgress?: (line: string) => void | Promise<void>
): void {
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

function summarizeOutput(
  exitCode: number,
  output: string,
  timedOut: boolean,
  aborted: boolean,
  timeoutMs: number
): string {
  if (aborted) {
    return "Task aborted by user.";
  }

  if (timedOut) {
    return `Codex task timed out after ${timeoutMs}ms.`;
  }

  if (exitCode === 0) {
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? "Completed successfully.";
  }

  if (!output) {
    return `Codex exited with code ${exitCode}`;
  }

  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
    ...guidanceBlock,
    "User instruction:",
    context.instruction
  ].join("\n");
}
