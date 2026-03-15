import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface LocalChatLogEntry {
  id: string;
  timestamp: string;
  chatId: number;
  userId?: number;
  direction: "inbound" | "outbound";
  channel: "telegram" | "local";
  text: string;
  commandButtons?: string[];
}

export interface LocalChatLogEntryInput {
  chatId: number;
  userId?: number;
  direction: "inbound" | "outbound";
  channel: "telegram" | "local";
  text: string;
  commandButtons?: string[];
}

export class LocalChatLog {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly maxFileBytes: number = 2 * 1024 * 1024
  ) {}

  async append(input: LocalChatLogEntryInput): Promise<void> {
    const entry: LocalChatLogEntry = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      chatId: input.chatId,
      userId: input.userId,
      direction: input.direction,
      channel: input.channel,
      text: input.text,
      commandButtons: input.commandButtons && input.commandButtons.length > 0 ? [...input.commandButtons] : undefined
    };

    const line = JSON.stringify(entry);
    this.writeQueue = this.writeQueue.then(async () => {
      const parentDir = path.dirname(this.filePath);
      await mkdir(parentDir, { recursive: true });

      const existing = await readFile(this.filePath, "utf8").catch(() => "");
      const lines = existing
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      lines.push(line);

      const compacted = compactJsonlLines(lines, this.maxFileBytes);
      const nextContents = compacted.length > 0 ? `${compacted.join("\n")}\n` : "";
      await writeFile(this.filePath, nextContents, "utf8");
    });
    await this.writeQueue;
  }

  async tail(chatId: number, limit: number): Promise<LocalChatLogEntry[]> {
    await this.writeQueue;
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    if (!raw) {
      return [];
    }
    const lines = raw.trim().split("\n");
    const entries: LocalChatLogEntry[] = [];
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      const line = lines[index];
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as LocalChatLogEntry;
        if (parsed.chatId === chatId) {
          entries.push(parsed);
        }
      } catch {
        // Ignore malformed lines.
      }
    }
    return entries.reverse();
  }
}

export function defaultLocalChatLogPath(stateFilePath: string): string {
  return path.join(path.dirname(path.resolve(stateFilePath)), "local-chat-log.jsonl");
}

function compactJsonlLines(lines: string[], maxFileBytes: number): string[] {
  const kept: string[] = [];
  let totalBytes = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (kept.length > 0 && totalBytes + lineBytes > maxFileBytes) {
      break;
    }
    if (kept.length === 0 && lineBytes > maxFileBytes) {
      continue;
    }
    kept.push(line);
    totalBytes += lineBytes;
  }

  return kept.reverse();
}
