import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileLocalCommandQueue, defaultLocalCommandQueuePath } from "../src/core/local-command-queue.js";

describe("FileLocalCommandQueue", () => {
  it("enqueues commands into inbox files", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-queue-"));
    const queue = new FileLocalCommandQueue(tmpDir, {
      now: () => new Date("2026-03-14T12:00:00.000Z")
    });

    const queued = await queue.enqueue({
      chatId: 100,
      userId: 1,
      text: "/status"
    });

    expect(queued.id).toMatch(/^lcmd_[a-f0-9]{16}$/);
    const files = await readdir(path.join(tmpDir, "inbox"));
    expect(files.length).toBe(1);

    const raw = await readFile(path.join(tmpDir, "inbox", files[0]), "utf8");
    expect(raw).toContain('"text": "/status"');
    expect(raw).toContain('"source": "local-cli"');
  });

  it("processes queued commands and moves files to processed", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-queue-"));
    const queue = new FileLocalCommandQueue(tmpDir, {
      pollIntervalMs: 10
    });

    const seen: string[] = [];
    await queue.enqueue({
      chatId: 100,
      userId: 1,
      text: "/status"
    });

    await queue.start(async (command) => {
      seen.push(command.text);
    });

    for (let i = 0; i < 20; i += 1) {
      if (seen.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    queue.stop();

    expect(seen).toEqual(["/status"]);
    const inboxFiles = await readdir(path.join(tmpDir, "inbox"));
    const processedFiles = await readdir(path.join(tmpDir, "processed"));
    expect(inboxFiles).toEqual([]);
    expect(processedFiles.length).toBe(1);
  });

  it("moves failed commands to failed directory", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-local-queue-"));
    const queue = new FileLocalCommandQueue(tmpDir, {
      pollIntervalMs: 10
    });

    await queue.enqueue({
      chatId: 100,
      userId: 1,
      text: "/status"
    });

    await queue.start(async () => {
      throw new Error("boom");
    });

    for (let i = 0; i < 20; i += 1) {
      const failedFiles = await readdir(path.join(tmpDir, "failed"));
      if (failedFiles.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    queue.stop();

    const failedFiles = await readdir(path.join(tmpDir, "failed"));
    expect(failedFiles.length).toBe(1);
  });

  it("derives default queue path from state file path", () => {
    const derived = defaultLocalCommandQueuePath("/tmp/codefox/state.json");
    expect(derived).toBe("/tmp/codefox/local-command-queue");
  });
});
