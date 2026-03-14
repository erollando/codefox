import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/core/audit-logger.js";

describe("AuditLogger", () => {
  it("truncates the audit log when maxFileBytes is exceeded", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "codefox-audit-"));
    const logPath = path.join(tmpDir, "audit.log");
    const logger = new AuditLogger(logPath, false, 180);

    await logger.log({ type: "first_event", payload: "x".repeat(120) });
    await logger.log({ type: "second_event", payload: "y".repeat(120) });

    const content = await readFile(logPath, "utf8");
    expect(content).toContain('"type":"second_event"');
    expect(content).not.toContain('"type":"first_event"');
  });
});
