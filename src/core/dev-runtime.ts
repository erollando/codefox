import { spawn } from "node:child_process";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface EnsureCodeFoxRunningResult {
  started: boolean;
  pid?: number;
  runningPids: number[];
}

export async function ensureCodeFoxRunning(input: {
  resolvedConfigPath: string;
  stateFilePath: string;
  waitTimeoutMs?: number;
}): Promise<EnsureCodeFoxRunningResult> {
  const runningBefore = await findRunningCodeFoxPids(input.resolvedConfigPath, input.stateFilePath);
  if (runningBefore.length > 0) {
    return {
      started: false,
      runningPids: runningBefore
    };
  }

  const pid = startCodeFoxProcess(input.resolvedConfigPath);
  if (!pid || pid <= 0) {
    throw new Error(`Failed to start CodeFox process for config ${input.resolvedConfigPath}.`);
  }
  await persistRelayPid(relayPidFilePath(input.stateFilePath), pid);

  const waitTimeoutMs = typeof input.waitTimeoutMs === "number" && input.waitTimeoutMs > 0 ? input.waitTimeoutMs : 10000;
  const started = await waitForRunningProcess(input.resolvedConfigPath, input.stateFilePath, waitTimeoutMs);
  if (!started) {
    throw new Error(`Started CodeFox (pid ${pid}) but could not confirm runtime startup within ${waitTimeoutMs}ms.`);
  }

  return {
    started: true,
    pid,
    runningPids: [pid]
  };
}

export async function stopOwnedCodeFoxProcess(input: {
  pid?: number;
  stateFilePath: string;
}): Promise<void> {
  const pid = input.pid;
  if (!pid || pid <= 0) {
    return;
  }

  if (!isProcessAlive(pid)) {
    await removeRelayPidIfMatches(input.stateFilePath, pid);
    return;
  }

  try {
    process.kill(pid);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ESRCH") {
      throw error;
    }
  }

  const stoppedGracefully = await waitForProcessExit(pid, 5000);
  if (!stoppedGracefully) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ESRCH") {
        throw error;
      }
    }
    await waitForProcessExit(pid, 2000);
  }

  await removeRelayPidIfMatches(input.stateFilePath, pid);
}

async function waitForRunningProcess(
  resolvedConfigPath: string,
  stateFilePath: string,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const running = await findRunningCodeFoxPids(resolvedConfigPath, stateFilePath);
    if (running.length > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function findRunningCodeFoxPids(resolvedConfigPath: string, stateFilePath: string): Promise<number[]> {
  const pids = new Set<number>();
  const pidFilePath = relayPidFilePath(stateFilePath);
  const pidFromFile = await readRelayPid(pidFilePath);
  if (pidFromFile && isProcessAlive(pidFromFile) && (await isLikelyCodeFoxProcess(pidFromFile))) {
    pids.add(pidFromFile);
  }
  const scanned = await findCodeFoxPidsByConfig(resolvedConfigPath);
  for (const pid of scanned) {
    pids.add(pid);
  }
  return [...pids].sort((left, right) => left - right);
}

function startCodeFoxProcess(resolvedConfigPath: string): number | undefined {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", "dev", "--", resolvedConfigPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  return child.pid;
}

function relayPidFilePath(stateFilePath: string): string {
  const stateDir = path.dirname(path.resolve(stateFilePath));
  return path.join(stateDir, "codefox.dev.pid");
}

async function persistRelayPid(pidFilePath: string, pid: number): Promise<void> {
  try {
    await writeFile(pidFilePath, `${pid}\n`, "utf8");
  } catch {
    // Non-fatal: caller still receives pid and stop instructions.
  }
}

async function readRelayPid(pidFilePath: string): Promise<number | undefined> {
  try {
    const raw = await readFile(pidFilePath, "utf8");
    const parsed = Number(raw.trim());
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

async function isLikelyCodeFoxProcess(pid: number): Promise<boolean> {
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const normalized = cmdline.replace(/\u0000/g, " ");
    return normalized.includes("codefox") && (normalized.includes("src/index.ts") || normalized.includes("dist/index.js"));
  } catch {
    return true;
  }
}

async function findCodeFoxPidsByConfig(configPath: string): Promise<number[]> {
  if (process.platform !== "linux") {
    return [];
  }
  const resolvedConfigPath = path.resolve(configPath);
  const entries = await readdir("/proc", { withFileTypes: true }).catch(() => []);
  const matches: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!cmdline) {
      continue;
    }
    const normalized = cmdline.replace(/\u0000/g, " ").trim();
    if (
      (normalized.includes("src/index.ts") || normalized.includes("dist/index.js")) &&
      normalized.includes(resolvedConfigPath)
    ) {
      matches.push(pid);
    }
  }
  return matches;
}

async function removeRelayPidIfMatches(stateFilePath: string, pid: number): Promise<void> {
  const pidFilePath = relayPidFilePath(stateFilePath);
  const pidFromFile = await readRelayPid(pidFilePath);
  if (pidFromFile !== pid) {
    return;
  }
  try {
    await unlink(pidFilePath);
  } catch {
    // Non-fatal cleanup.
  }
}
