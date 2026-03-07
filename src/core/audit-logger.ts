import { mkdir, appendFile } from "node:fs/promises";
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
  constructor(
    private readonly logFilePath: string,
    private readonly mirrorToStdout: boolean = false
  ) {}

  async log(event: AuditEventInput): Promise<void> {
    const full: AuditEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };

    const line = `${JSON.stringify(full)}\n`;
    const parentDir = path.dirname(this.logFilePath);
    await mkdir(parentDir, { recursive: true });
    await appendFile(this.logFilePath, line, "utf8");

    if (this.mirrorToStdout) {
      console.log(line.trim());
    }
  }
}
