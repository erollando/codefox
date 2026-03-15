import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stopOwnedCodeFoxProcess } from "../src/core/dev-runtime.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code !== "ESRCH";
  }
}

describe("dev runtime", () => {
  it("stops the detached runtime group even after the launcher exits", async () => {
    if (process.platform !== "linux") {
      return;
    }

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-dev-runtime-"));
    const stateFilePath = path.join(tmpDir, "state.json");
    const pidFilePath = path.join(tmpDir, "codefox.dev.pid");
    const childPidPath = path.join(tmpDir, "child.pid");

    const launcher = spawn("bash", ["-lc", `sleep 60 & echo $! > ${JSON.stringify(childPidPath)}`], {
      detached: true,
      stdio: "ignore"
    });
    launcher.unref();

    if (!launcher.pid || launcher.pid <= 0) {
      throw new Error("Expected detached launcher pid.");
    }

    await writeFile(stateFilePath, "{}\n", "utf8");
    await writeFile(pidFilePath, `${launcher.pid}\n`, "utf8");

    const startedAt = Date.now();
    let childPid: number | undefined;
    while (Date.now() - startedAt <= 5000) {
      const rawChildPid = await readFile(childPidPath, "utf8").catch(() => "");
      const parsedChildPid = Number(rawChildPid.trim());
      if (Number.isSafeInteger(parsedChildPid) && parsedChildPid > 0 && isProcessAlive(parsedChildPid)) {
        childPid = parsedChildPid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(childPid).toBeDefined();
    const launcherWaitStartedAt = Date.now();
    while (Date.now() - launcherWaitStartedAt <= 5000 && isProcessAlive(launcher.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isProcessAlive(launcher.pid)).toBe(false);

    await stopOwnedCodeFoxProcess({
      pid: launcher.pid,
      stateFilePath
    });

    expect(isProcessAlive(childPid as number)).toBe(false);
  });
});
