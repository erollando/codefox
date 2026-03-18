import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface LocalQueuedCommand {
  id: string;
  chatId: number;
  userId: number;
  text: string;
  createdAt: string;
  source: "local-cli";
}

export interface LocalCommandEnqueueInput {
  chatId: number;
  userId: number;
  text: string;
  createdAt?: string;
}

export interface LocalCommandQueueOptions {
  now?: () => Date;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 750;

export class FileLocalCommandQueue {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private polling = false;

  constructor(
    private readonly rootDir: string,
    options: LocalCommandQueueOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async enqueue(input: LocalCommandEnqueueInput): Promise<LocalQueuedCommand> {
    if (!Number.isSafeInteger(input.chatId) || input.chatId === 0) {
      throw new Error("chatId must be a non-zero safe integer.");
    }
    if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
      throw new Error("userId must be a positive integer.");
    }
    if (!input.text || input.text.trim().length === 0) {
      throw new Error("text must be non-empty.");
    }

    const now = input.createdAt ? new Date(input.createdAt) : this.now();
    const command: LocalQueuedCommand = {
      id: `lcmd_${randomHex(8)}`,
      chatId: input.chatId,
      userId: input.userId,
      text: input.text,
      createdAt: now.toISOString(),
      source: "local-cli"
    };

    const fileName = `${command.createdAt.replaceAll(":", "-")}_${command.id}.json`;
    await this.ensureDirs();
    await writeFile(path.join(this.inboxDir(), fileName), `${JSON.stringify(command, null, 2)}\n`, "utf8");
    return command;
  }

  async start(handler: (command: LocalQueuedCommand) => Promise<void>): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.ensureDirs();
    await this.pollOnce(handler);
    this.timer = setInterval(() => {
      void this.pollOnce(handler);
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async pollOnce(handler: (command: LocalQueuedCommand) => Promise<void>): Promise<void> {
    if (!this.running || this.polling) {
      return;
    }
    this.polling = true;
    try {
      await this.ensureDirs();
      const files = await readdir(this.inboxDir());
      const targets = files.filter((file) => file.endsWith(".json")).sort();

      for (const file of targets) {
        const sourcePath = path.join(this.inboxDir(), file);
        const raw = await readFile(sourcePath, "utf8");
        const parsed = parseQueuedCommand(raw);
        if (!parsed.ok) {
          const failedPath = path.join(this.failedDir(), file);
          await rename(sourcePath, failedPath);
          continue;
        }

        try {
          await handler(parsed.command);
          const processedPath = path.join(this.processedDir(), file);
          await rename(sourcePath, processedPath);
        } catch {
          const failedPath = path.join(this.failedDir(), file);
          await rename(sourcePath, failedPath);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  inboxPath(): string {
    return this.inboxDir();
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.inboxDir(), { recursive: true });
    await mkdir(this.processedDir(), { recursive: true });
    await mkdir(this.failedDir(), { recursive: true });
  }

  private inboxDir(): string {
    return path.join(this.rootDir, "inbox");
  }

  private processedDir(): string {
    return path.join(this.rootDir, "processed");
  }

  private failedDir(): string {
    return path.join(this.rootDir, "failed");
  }
}

export function defaultLocalCommandQueuePath(stateFilePath: string): string {
  return path.join(path.dirname(stateFilePath), "local-command-queue");
}

function parseQueuedCommand(raw: string): { ok: true; command: LocalQueuedCommand } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false };
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.id !== "string" ||
    typeof obj.chatId !== "number" ||
    !Number.isSafeInteger(obj.chatId) ||
    obj.chatId === 0 ||
    typeof obj.userId !== "number" ||
    !Number.isSafeInteger(obj.userId) ||
    obj.userId <= 0 ||
    typeof obj.text !== "string" ||
    obj.text.trim().length === 0 ||
    typeof obj.createdAt !== "string" ||
    !Number.isFinite(Date.parse(obj.createdAt)) ||
    obj.source !== "local-cli"
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    command: {
      id: obj.id,
      chatId: obj.chatId,
      userId: obj.userId,
      text: obj.text,
      createdAt: obj.createdAt,
      source: "local-cli"
    }
  };
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
