import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface AuditEventInput {
  type: string;
  [key: string]: unknown;
}

export class AuditLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly logFilePath: string,
    private readonly mirrorToStdout: boolean = false,
    private readonly maxFileBytes: number = 5 * 1024 * 1024
  ) {}

  async log(event: AuditEventInput): Promise<void> {
    const full: AuditEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };

    const line = `${JSON.stringify(full)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        const parentDir = path.dirname(this.logFilePath);
        await mkdir(parentDir, { recursive: true });

        const lineBytes = Buffer.byteLength(line, "utf8");
        const currentSize = await this.readFileSize();
        if (currentSize + lineBytes > this.maxFileBytes) {
          await writeFile(this.logFilePath, "", "utf8");
        }
        await appendFile(this.logFilePath, line, "utf8");
      })
      .catch((error) => {
        console.error(`Audit log write failure: ${String(error)}`);
      });
    await this.writeQueue;

    if (this.mirrorToStdout) {
      console.log(line.trim());
    }
  }

  private async readFileSize(): Promise<number> {
    try {
      const info = await stat(this.logFilePath);
      return info.size;
    } catch {
      return 0;
    }
  }
}
